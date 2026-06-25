import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import {
  clone,
  createSourceKey,
  dataSourceForType,
  type BuiltinTemplate,
  type ConnectivityConfig,
  type IngestAdapterId,
  type OverlayDataSource,
  type OverlayDesign,
  type OverlayDocumentV2,
  type OverlaySource,
  type OverlayType,
  type UserPreset,
  type UploadProgressConfig,
} from "./model.js";
import { designFromTemplate, OverlayStore, StoreConflictError, StoreValidationError } from "./store.js";
import { TelemetryHub, type TelemetrySnapshot } from "./telemetry.js";
import { UploadProgressHub, type IngestProgressSnapshot } from "./ingest.js";

export interface FrameOverlaysConfig {
  publicBaseUrl: string;
  requestTimeoutMs: number;
  username?: string;
  password?: string;
  slsApiKey: string;
}

export interface CreateFrameOverlaysOptions {
  config: FrameOverlaysConfig;
  store: OverlayStore;
  publicDir: string;
  streamsFetch: (route: string, init?: RequestInit) => Promise<Response>;
  photoUploadFetch?: (route: string, init?: RequestInit) => Promise<Response>;
  telemetryHub?: TelemetryHub;
  uploadProgressHub?: UploadProgressHub;
}

export interface FrameOverlaysRuntime {
  app: express.Express;
  telemetryHub: TelemetryHub;
  uploadProgressHub: UploadProgressHub;
  close: () => void;
}

type SourceRoute = { kind: "legacy"; id: string } | { kind: "canonical"; slug: string; sourceKey: string };
type ConfigListener = () => void | Promise<void>;
type SourceSnapshot = TelemetrySnapshot | IngestProgressSnapshot;

export async function createFrameOverlaysApp(options: CreateFrameOverlaysOptions): Promise<FrameOverlaysRuntime> {
  const { config, store, publicDir, streamsFetch } = options;
  await store.init();
  const rendererPaths = {
    connectivity: path.join(publicDir, "renderer.html"),
    upload_progress: path.join(publicDir, "upload-renderer.html"),
  } as const;
  const configEvents = new SourceConfigEvents();
  const telemetryHub = options.telemetryHub ?? new TelemetryHub(async (streamProfileId) => {
    const response = await streamsFetch(`/internal/streams/${encodeURIComponent(streamProfileId)}/stats`);
    if (!response.ok) throw new RequestError(response.status, `Stream Management returned ${response.status}`);
    return response.json();
  });
  const uploadProgressHub = options.uploadProgressHub ?? new UploadProgressHub(async (adapter) => {
    if (adapter !== "web_upload") throw new Error(`${adapter} ingest telemetry is not configured yet.`);
    if (!options.photoUploadFetch) throw new Error("Web-upload telemetry is unavailable.");
    const response = await options.photoUploadFetch("/api/internal/photo-upload/progress");
    if (!response.ok) throw new RequestError(response.status, `Photo Upload returned ${response.status}`);
    return response.json();
  });
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  app.use("/overlays/assets", express.static(publicDir, { maxAge: 0 }));

  app.get("/healthz", async (_request, response) => {
    try {
      const upstream = await streamsFetch("/internal/streams");
      response.status(upstream.ok ? 200 : 503).json({
        ok: upstream.ok,
        service: "frame-overlays",
        telemetry: upstream.ok ? "ready" : "unavailable",
      });
    } catch {
      response.status(503).json({ ok: false, service: "frame-overlays", telemetry: "unavailable" });
    }
  });

  app.get("/overlays/stats/:player", (_request, response) => {
    response.status(410).json({ error: "This broad telemetry route is deprecated. Use a source-scoped overlay URL." });
  });

  registerPublicRoutes(app, "/overlays/view/:slug/:sourceKey", (request) => ({
    kind: "canonical",
    slug: request.params.slug,
    sourceKey: request.params.sourceKey,
  }));
  registerPublicRoutes(app, "/overlays/view/:id", (request) => ({ kind: "legacy", id: request.params.id }));

  app.get("/internal/streams/overlay-bindings", requireInternalAuth(config), async (_request, response, next) => {
    try {
      const document = await store.read();
      response.json({
        bindings: document.sources.flatMap((source) => {
          if (source.data_source.kind !== "stream" || !source.data_source.stream_profile_id) return [];
          const preset = document.presets.find((candidate) => candidate.id === source.preset_id);
          if (!preset) return [];
          return [{
            stream_profile_id: source.data_source.stream_profile_id,
            source_id: source.id,
            display_name: source.display_name,
            slug: source.slug,
            preset_name: preset.name,
            enabled: source.enabled && preset.enabled,
          }];
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/internal/streams/:player/unbind", requireInternalAuth(config), async (request, response, next) => {
    try {
      const player = validSlsId(request.params.player);
      const changedSources: string[] = [];
      const document = await mutateLatest(store, (draft) => {
        const now = new Date().toISOString();
        for (const source of draft.sources) {
          if (source.data_source.kind !== "stream" || source.data_source.stream_profile_id !== player) continue;
          source.data_source.stream_profile_id = null;
          source.revision += 1;
          source.updated_at = now;
          changedSources.push(source.id);
        }
      });
      for (const sourceId of changedSources) configEvents.publish(sourceId);
      response.json({ unbound_sources: changedSources, revision: document.revision });
    } catch (error) {
      next(error);
    }
  });

  app.use("/overlays/api", requireManagementAuth(config));

  app.get("/overlays/api/config", async (_request, response, next) => {
    try {
      const document = await store.read();
      response.json({
        public_base_url: config.publicBaseUrl,
        schema_version: document.schema_version,
        default_template_id: document.default_template_id,
        default_template_ids: document.default_template_ids,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/overlays/api/streams", async (_request, response, next) => {
    try {
      const upstream = await streamsFetch("/internal/streams");
      if (!upstream.ok) throw new RequestError(upstream.status, `Stream Management returned ${upstream.status}`);
      const result = await upstream.json() as { streams?: unknown[] };
      response.json({ streams: result.streams ?? [] });
    } catch (error) {
      next(error);
    }
  });

  app.get(["/overlays/api/catalog", "/overlays/api/presets"], async (_request, response, next) => {
    try {
      response.json(await store.read());
    } catch (error) {
      next(error);
    }
  });

  app.get("/overlays/api/preview/:id", async (request, response, next) => {
    try {
      const preset = findPreset(await store.read(), validId(request.params.id));
      const html = await readFile(rendererPathFor(preset.type), "utf8");
      const payload = JSON.stringify({
        schema_version: "2.0",
        revision: `preview:${preset.revision}`,
        preset,
        source: { id: "preview-source", slug: "preview", display_name: preset.name, enabled: true, revision: 1, data_source: dataSourceForType(preset.type) },
        telemetry_identity: "preview",
        stream_display_name: preset.name,
        server_name: new URL(config.publicBaseUrl).hostname,
        settings_url: null,
        stats_url: null,
        events_url: null,
      }).replaceAll("<", "\\u003c");
      response.setHeader("Cache-Control", "no-store");
      response.type("html").send(html.replace("/*__FRAME_OVERLAY_CONFIG__*/null", payload));
    } catch (error) {
      next(error);
    }
  });

  app.get("/overlays/api/preview-template/:id", async (request, response, next) => {
    try {
      const template = findTemplate(await store.read(), validId(request.params.id));
      const html = await readFile(rendererPathFor(template.type), "utf8");
      const preset = {
        ...designFromTemplate(template),
        id: `preview-${template.id}`,
        template_id: template.id,
        revision: 1,
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
      };
      const payload = JSON.stringify({
        schema_version: "2.0",
        revision: `template:${template.id}`,
        preset,
        source: { id: "preview-source", slug: "preview", display_name: template.name, enabled: true, revision: 1, data_source: dataSourceForType(template.type) },
        telemetry_identity: "preview",
        stream_display_name: template.name,
        server_name: new URL(config.publicBaseUrl).hostname,
        settings_url: null,
        stats_url: null,
        events_url: null,
      }).replaceAll("<", "\\u003c");
      response.setHeader("Cache-Control", "no-store");
      response.type("html").send(html.replace("/*__FRAME_OVERLAY_CONFIG__*/null", payload));
    } catch (error) {
      next(error);
    }
  });

  app.all("/overlays/api/templates/:id", (_request, response) => {
    response.status(405).json({ error: "Built-in templates are read-only. Create a preset or source from the template instead." });
  });

  app.post("/overlays/api/presets", async (request, response, next) => {
    try {
      const body = objectBody(request.body);
      const expectedRevision = expectedStateRevision(request, body);
      let created!: UserPreset;
      const document = await store.mutate(expectedRevision, (draft) => {
        const template = findTemplate(draft, validId(body.template_id));
        const now = new Date().toISOString();
        const id = uniquePresetId(draft, cleanText(body.id, 64) || cleanText(body.name, 80));
        created = {
          ...designFromTemplate(template),
          id,
          template_id: template.id,
          name: requiredText(body.name, 80, "Preset name"),
          revision: 1,
          created_at: now,
          updated_at: now,
        };
        draft.presets.push(created);
      });
      response.status(201).setHeader("ETag", revisionEtag(document.revision)).json({ preset: created, revision: document.revision });
    } catch (error) {
      next(error);
    }
  });

  app.put("/overlays/api/presets/:id", async (request, response, next) => {
    try {
      const id = validId(request.params.id);
      const body = objectBody(request.body);
      const expectedRevision = expectedStateRevision(request, body);
      let saved!: UserPreset;
      let affectedSources: string[] = [];
      const document = await store.mutate(expectedRevision, (draft) => {
        const index = draft.presets.findIndex((preset) => preset.id === id);
        if (index < 0) throw new RequestError(404, "Preset not found.");
        const current = draft.presets[index];
        const design = parseDesign(body.preset ?? body, current.type);
        saved = {
          ...current,
          ...design,
          id: current.id,
          type: current.type,
          template_id: current.template_id,
          revision: current.revision + 1,
          created_at: current.created_at,
          updated_at: new Date().toISOString(),
        } as UserPreset;
        draft.presets[index] = saved;
        affectedSources = draft.sources.filter((source) => source.preset_id === id).map((source) => source.id);
      });
      for (const sourceId of affectedSources) configEvents.publish(sourceId);
      response.setHeader("ETag", revisionEtag(document.revision)).json({ preset: saved, revision: document.revision });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/overlays/api/presets/:id", async (request, response, next) => {
    try {
      const id = validId(request.params.id);
      const expectedRevision = expectedStateRevision(request, objectBody(request.body));
      const document = await store.mutate(expectedRevision, (draft) => {
        if (draft.sources.some((source) => source.preset_id === id)) {
          throw new RequestError(409, "Delete the sources using this preset first.");
        }
        const nextPresets = draft.presets.filter((preset) => preset.id !== id);
        if (nextPresets.length === draft.presets.length) throw new RequestError(404, "Preset not found.");
        draft.presets = nextPresets;
      });
      response.setHeader("ETag", revisionEtag(document.revision)).status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post("/overlays/api/sources", async (request, response, next) => {
    try {
      const body = objectBody(request.body);
      const expectedRevision = expectedStateRevision(request, body);
      let createdSource!: OverlaySource;
      let createdPreset: UserPreset | undefined;
      const document = await store.mutate(expectedRevision, (draft) => {
        let preset: UserPreset;
        if (body.preset_id) {
          preset = findPreset(draft, validId(body.preset_id));
        } else {
          const template = findTemplate(draft, validId(body.template_id));
          const now = new Date().toISOString();
          createdPreset = {
            ...designFromTemplate(template),
            id: uniquePresetId(draft, cleanText(body.preset_name, 80) || `${cleanText(body.display_name, 80)} preset`),
            template_id: template.id,
            name: cleanText(body.preset_name, 80) || `${requiredText(body.display_name, 80, "Display name")} Preset`,
            revision: 1,
            created_at: now,
            updated_at: now,
          };
          draft.presets.push(createdPreset);
          preset = createdPreset;
        }
        const displayName = requiredText(body.display_name, 80, "Display name");
        assertUniqueSourceName(draft, displayName);
        const slug = validId(body.slug);
        assertUniqueSourceSlug(draft, slug);
        const now = new Date().toISOString();
        createdSource = {
          id: `source-${randomUUID()}`,
          slug,
          source_key: createSourceKey(),
          display_name: displayName,
          preset_id: preset.id,
          enabled: true,
          data_source: parseDataSource(body.data_source, preset.type),
          revision: 1,
          created_at: now,
          updated_at: now,
        };
        draft.sources.push(createdSource);
      });
      response.status(201).setHeader("ETag", revisionEtag(document.revision)).json({
        source: publicManagementSource(createdSource, config.publicBaseUrl),
        preset: createdPreset,
        revision: document.revision,
      });
    } catch (error) {
      next(error);
    }
  });

  app.put("/overlays/api/sources/:id", async (request, response, next) => {
    try {
      const id = validId(request.params.id);
      const body = objectBody(request.body);
      const expectedRevision = expectedStateRevision(request, body);
      let saved!: OverlaySource;
      const document = await store.mutate(expectedRevision, (draft) => {
        const index = draft.sources.findIndex((source) => source.id === id);
        if (index < 0) throw new RequestError(404, "Source not found.");
        const current = draft.sources[index];
        const currentPreset = findPreset(draft, current.preset_id);
        const presetId = body.preset_id ? validId(body.preset_id) : current.preset_id;
        const preset = findPreset(draft, presetId);
        if (preset.type !== currentPreset.type) throw new RequestError(409, "A source cannot switch to a preset of another overlay type.");
        if (body.slug !== undefined && body.slug !== current.slug) throw new RequestError(409, "Source slugs are permanent.");
        if (body.source_key !== undefined && body.source_key !== current.source_key) throw new RequestError(409, "Source keys are permanent.");
        const displayName = body.display_name === undefined ? current.display_name : requiredText(body.display_name, 80, "Display name");
        assertUniqueSourceName(draft, displayName, current.id);
        saved = {
          ...current,
          display_name: displayName,
          preset_id: presetId,
          enabled: body.enabled === undefined ? current.enabled : Boolean(body.enabled),
          data_source: body.data_source === undefined ? current.data_source : parseDataSource(body.data_source, preset.type),
          revision: current.revision + 1,
          updated_at: new Date().toISOString(),
        };
        draft.sources[index] = saved;
      });
      configEvents.publish(saved.id);
      response.setHeader("ETag", revisionEtag(document.revision)).json({
        source: publicManagementSource(saved, config.publicBaseUrl),
        revision: document.revision,
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/overlays/api/sources/:id", async (request, response, next) => {
    try {
      const id = validId(request.params.id);
      const expectedRevision = expectedStateRevision(request, objectBody(request.body));
      const document = await store.mutate(expectedRevision, (draft) => {
        const deleted = draft.sources.find((source) => source.id === id);
        const nextSources = draft.sources.filter((source) => source.id !== id);
        if (nextSources.length === draft.sources.length) throw new RequestError(404, "Source not found.");
        draft.sources = nextSources;
        if (deleted && !draft.sources.some((source) => source.preset_id === deleted.preset_id)) {
          draft.presets = draft.presets.filter((preset) => preset.id !== deleted.preset_id);
        }
        for (const [alias, sourceId] of Object.entries(draft.legacy_aliases)) {
          if (sourceId === id) delete draft.legacy_aliases[alias];
        }
      });
      configEvents.publish(id);
      response.setHeader("ETag", revisionEtag(document.revision)).status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.use(["/overlays", "/overlays/setup"], requireManagementAuth(config));
  app.get(["/overlays", "/overlays/setup"], (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.sendFile(path.join(publicDir, "index.html"));
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const status = error instanceof RequestError
      ? error.status
      : error instanceof StoreConflictError
        ? 409
        : error instanceof StoreValidationError
          ? 400
        : 500;
    if (status >= 500) console.error("[overlays]", error);
    response.status(status).json({
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof StoreConflictError ? { current_revision: error.actualRevision } : {}),
    });
  });

  return { app, telemetryHub, uploadProgressHub, close: () => { telemetryHub.stop(); uploadProgressHub.stop(); } };

  function registerPublicRoutes(
    target: express.Express,
    route: string,
    routeFromRequest: (request: express.Request) => SourceRoute,
  ): void {
    target.get(route, async (request, response, next) => {
      try {
        const resolved = resolveSource(await store.read(), routeFromRequest(request));
        assertRenderable(resolved.source, resolved.preset);
        const html = await readFile(rendererPathFor(resolved.preset.type), "utf8");
        const payload = JSON.stringify(await rendererPayload(resolved.source, resolved.preset, request.path)).replaceAll("<", "\\u003c");
        response.setHeader("Cache-Control", "no-store");
        const title = escapeHtml(resolved.preset.window_title || resolved.source.display_name || "FRAME Overlay");
        response.type("html").send(html
          .replace("<title>FRAME Overlay</title>", `<title>${title}</title>`)
          .replace("/*__FRAME_OVERLAY_CONFIG__*/null", payload));
      } catch (error) {
        next(error);
      }
    });

    target.get(`${route}/config`, async (request, response, next) => {
      try {
        const resolved = resolveSource(await store.read(), routeFromRequest(request));
        assertRenderable(resolved.source, resolved.preset);
        response.setHeader("Cache-Control", "no-store");
        response.json(await rendererPayload(resolved.source, resolved.preset, request.path.replace(/\/config$/, "")));
      } catch (error) {
        next(error);
      }
    });

    target.get(`${route}/stats`, async (request, response, next) => {
      try {
        const resolved = resolveSource(await store.read(), routeFromRequest(request));
        assertRenderable(resolved.source, resolved.preset);
        response.setHeader("Cache-Control", "no-store");
        response.json(await sourceTelemetry(resolved.source, resolved.preset));
      } catch (error) {
        next(error);
      }
    });

    target.get(`${route}/events`, async (request, response, next) => {
      try {
        const resolved = resolveSource(await store.read(), routeFromRequest(request));
        assertRenderable(resolved.source, resolved.preset);
        response.status(200);
        response.setHeader("Content-Type", "text/event-stream");
        response.setHeader("Cache-Control", "no-cache, no-transform");
        response.setHeader("Connection", "keep-alive");
        response.flushHeaders();
        response.write("retry: 2000\n\n");

        const routeBase = request.path.replace(/\/events$/, "");
        let activeTelemetrySubscription = "";
        let unsubscribeTelemetry: () => void = () => undefined;
        const sendConfig = async () => {
          try {
            const latest = resolveSource(await store.read(), routeFromRequest(request));
            sendEvent(response, "config", await rendererPayload(latest.source, latest.preset, routeBase));
            const subscriptionIdentity = `${telemetryIdentity(latest.source.data_source)}:${pollingIdentity(latest.preset)}`;
            if (subscriptionIdentity !== activeTelemetrySubscription) {
              unsubscribeTelemetry();
              activeTelemetrySubscription = subscriptionIdentity;
              unsubscribeTelemetry = subscribeSourceTelemetry(latest.source, latest.preset, (snapshot) => {
                sendEvent(response, "telemetry", snapshot);
              });
            }
          } catch (error) {
            sendEvent(response, "source-error", { error: error instanceof Error ? error.message : String(error) });
          }
        };
        await sendConfig();
        const unsubscribeConfig = configEvents.subscribe(resolved.source.id, sendConfig);
        const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
        request.on("close", () => {
          clearInterval(heartbeat);
          unsubscribeConfig();
          unsubscribeTelemetry();
        });
      } catch (error) {
        next(error);
      }
    });
  }

  async function rendererPayload(source: OverlaySource, preset: UserPreset, routeBase: string): Promise<Record<string, unknown>> {
    return {
      schema_version: "2.0",
      revision: `${preset.revision}:${source.revision}`,
      preset: clone(preset),
      source: { id: source.id, slug: source.slug, display_name: source.display_name, enabled: source.enabled, revision: source.revision, data_source: clone(source.data_source) },
      telemetry_identity: telemetryIdentity(source.data_source),
      stream_display_name: await resolveStreamDisplayName(source),
      server_name: new URL(config.publicBaseUrl).hostname,
      settings_url: `${routeBase}/config`,
      stats_url: `${routeBase}/stats`,
      events_url: `${routeBase}/events`,
    };
  }

  async function sourceTelemetry(source: OverlaySource, preset: UserPreset): Promise<SourceSnapshot> {
    if (source.data_source.kind === "upload_progress" && preset.type === "upload_progress") {
      const uploadConfig = uploadProgressConfig(preset);
      return uploadProgressHub.snapshot(source.data_source.adapters, uploadConfig.active_poll_ms ?? 200, uploadConfig.idle_poll_ms ?? 1000);
    }
    if (source.data_source.kind !== "stream" || !source.data_source.stream_profile_id) return unboundTelemetry();
    return telemetryHub.snapshot(source.data_source.stream_profile_id, connectivityConfig(preset).poll_ms ?? 1000);
  }

  function subscribeSourceTelemetry(source: OverlaySource, preset: UserPreset, listener: (snapshot: SourceSnapshot) => void): () => void {
    if (source.data_source.kind === "upload_progress" && preset.type === "upload_progress") {
      const uploadConfig = uploadProgressConfig(preset);
      return uploadProgressHub.subscribe(source.data_source.adapters, uploadConfig.active_poll_ms ?? 200, uploadConfig.idle_poll_ms ?? 1000, listener);
    }
    if (source.data_source.kind !== "stream" || !source.data_source.stream_profile_id) {
      listener(unboundTelemetry());
      return () => undefined;
    }
    return telemetryHub.subscribe(source.data_source.stream_profile_id, connectivityConfig(preset).poll_ms ?? 1000, listener);
  }

  function rendererPathFor(type: OverlayType): string {
    if (type === "connectivity") return rendererPaths.connectivity;
    if (type === "upload_progress") return rendererPaths.upload_progress;
    throw new RequestError(501, `Renderer for ${type} is not implemented yet.`);
  }

  async function resolveStreamDisplayName(source: OverlaySource): Promise<string> {
    if (source.data_source.kind === "stream" && source.data_source.stream_profile_id) {
      const streamProfileId = source.data_source.stream_profile_id;
      try {
        const upstream = await streamsFetch("/internal/streams");
        if (upstream.ok) {
          const result = await upstream.json() as { streams?: Array<{ player?: string; description?: string }> };
          const stream = result.streams?.find((candidate) => candidate.player === streamProfileId);
          if (stream?.description) return cleanText(stream.description, 80);
        }
      } catch {
        // Friendly metadata is optional; the stable source display name remains available.
      }
    }
    return source.display_name;
  }
}

class SourceConfigEvents {
  private readonly listeners = new Map<string, Set<ConfigListener>>();

  subscribe(sourceId: string, listener: ConfigListener): () => void {
    const listeners = this.listeners.get(sourceId) ?? new Set<ConfigListener>();
    listeners.add(listener);
    this.listeners.set(sourceId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(sourceId);
    };
  }

  publish(sourceId: string): void {
    for (const listener of this.listeners.get(sourceId) ?? []) void listener();
  }
}

function resolveSource(document: OverlayDocumentV2, route: SourceRoute): { source: OverlaySource; preset: UserPreset } {
  const source = route.kind === "legacy"
    ? document.sources.find((candidate) => candidate.id === document.legacy_aliases[validId(route.id)] || candidate.id === route.id)
    : document.sources.find((candidate) => candidate.slug === validId(route.slug) && safeEqual(candidate.source_key, validSourceKey(route.sourceKey)));
  if (!source) throw new RequestError(404, "Overlay source not found.");
  return { source, preset: findPreset(document, source.preset_id) };
}

function assertRenderable(source: OverlaySource, preset: UserPreset): void {
  if (!source.enabled || !preset.enabled) throw new RequestError(404, "Overlay source is disabled.");
  if (preset.type !== "connectivity" && preset.type !== "upload_progress") throw new RequestError(501, `Renderer for ${preset.type} is not implemented yet.`);
}

function findPreset(document: OverlayDocumentV2, id: string): UserPreset {
  const preset = document.presets.find((candidate) => candidate.id === id);
  if (!preset) throw new RequestError(404, "Preset not found.");
  return preset;
}

function findTemplate(document: OverlayDocumentV2, id: string): BuiltinTemplate {
  const template = document.templates.find((candidate) => candidate.id === id);
  if (!template) throw new RequestError(404, "Template not found.");
  return template;
}

function assertUniqueSourceName(document: OverlayDocumentV2, displayName: string, exceptSourceId?: string): void {
  const normalized = normalizeIdentity(displayName);
  if (document.sources.some((source) => source.id !== exceptSourceId && normalizeIdentity(source.display_name) === normalized)) {
    throw new RequestError(409, "That source name is already in use.");
  }
}

function assertUniqueSourceSlug(document: OverlayDocumentV2, slug: string, exceptSourceId?: string): void {
  const normalized = normalizeIdentity(slug);
  if (document.sources.some((source) => source.id !== exceptSourceId && normalizeIdentity(source.slug) === normalized)) {
    throw new RequestError(409, "That source slug is already in use.");
  }
}

function normalizeIdentity(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function parseDesign(value: unknown, expectedType: OverlayType): OverlayDesign {
  const body = objectBody(value);
  if (body.type !== undefined && body.type !== expectedType) throw new RequestError(409, "A preset type cannot be changed in place.");
  const layout = objectBody(body.layout);
  const theme = objectBody(body.theme);
  const config = objectBody(body.config);
  const design = {
    type: expectedType,
    name: requiredText(body.name, 80, "Preset name"),
    description: cleanText(body.description, 280) || undefined,
    tags: Array.isArray(body.tags) ? body.tags.map((tag) => cleanText(tag, 32)).filter(Boolean).slice(0, 10) : undefined,
    enabled: body.enabled !== false,
    window_title: cleanText(body.window_title, 100) || undefined,
    layout,
    theme,
    config,
  } as unknown as OverlayDesign;
  const rttWarn = Number((config as ConnectivityConfig).rtt_warn_max);
  const rttBad = Number((config as ConnectivityConfig).rtt_bad_max);
  const rttMax = Number((config as ConnectivityConfig).chart_rtt_max);
  if ([rttWarn, rttBad, rttMax].every(Number.isFinite) && !(rttWarn < rttBad && rttBad < rttMax)) {
    throw new RequestError(400, "RTT levels must remain ordered: good < bad < max.");
  }
  if (Number.isFinite(rttMax) && rttMax > 5_000) {
    throw new RequestError(400, "RTT chart max cannot exceed 5000 ms.");
  }
  const bitrateWarn = Number((config as ConnectivityConfig).bitrate_warn_min);
  const bitrateGood = Number((config as ConnectivityConfig).bitrate_good_min);
  const bitrateMax = Number((config as ConnectivityConfig).bitrate_meter_max);
  if ([bitrateWarn, bitrateGood, bitrateMax].every(Number.isFinite) && !(bitrateWarn < bitrateGood && bitrateGood < bitrateMax)) {
    throw new RequestError(400, "Bitrate levels must remain ordered: warn < good < max.");
  }
  return design;
}

function parseDataSource(value: unknown, type: OverlayType): OverlayDataSource {
  const body = objectBody(value);
  const expectedKind = type === "connectivity" ? "stream" : type;
  if (body.kind !== expectedKind) throw new RequestError(400, `A ${type} preset requires a ${expectedKind} data source.`);
  if (expectedKind === "stream") {
    return {
      kind: "stream",
      stream_profile_id: body.stream_profile_id === null || body.stream_profile_id === ""
        ? null
        : validSlsId(body.stream_profile_id),
    };
  }
  if (expectedKind === "upload_progress") {
    const adapters = Array.isArray(body.adapters)
      ? body.adapters.map(ingestAdapterValue).filter((adapter): adapter is IngestAdapterId => Boolean(adapter))
      : ["web_upload" as const];
    const selected: IngestAdapterId[] = adapters.length ? adapters : ["web_upload"];
    return { kind: "upload_progress", adapters: [...new Set<IngestAdapterId>(selected)] };
  }
  return { kind: "latest_photo" };
}

function connectivityConfig(preset: UserPreset): ConnectivityConfig {
  return preset.type === "connectivity" ? preset.config : {};
}

function uploadProgressConfig(preset: UserPreset): UploadProgressConfig {
  return preset.type === "upload_progress" ? preset.config : {};
}

function pollingIdentity(preset: UserPreset): string {
  if (preset.type === "upload_progress") return `${preset.config.active_poll_ms ?? 200}:${preset.config.idle_poll_ms ?? 1000}`;
  return String(connectivityConfig(preset).poll_ms ?? 1000);
}

function ingestAdapterValue(value: unknown): IngestAdapterId | null {
  return value === "web_upload" || value === "ftp" || value === "belabox_agent" ? value : null;
}

function publicManagementSource(source: OverlaySource, publicBaseUrl: string): OverlaySource & { public_url: string } {
  return { ...clone(source), public_url: `${publicBaseUrl}/overlays/view/${encodeURIComponent(source.slug)}/${encodeURIComponent(source.source_key)}` };
}

function unboundTelemetry(): TelemetrySnapshot {
  return {
    sequence: 0,
    observed_at: new Date().toISOString(),
    received_at: null,
    stale: true,
    connected: false,
    publisher: null,
    error: "Source is not bound to a stream profile.",
  };
}

function sendEvent(response: express.Response, event: string, payload: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function telemetryIdentity(dataSource: OverlayDataSource): string {
  return createHash("sha256").update(JSON.stringify(dataSource)).digest("base64url").slice(0, 18);
}

async function mutateLatest(store: OverlayStore, mutation: (document: OverlayDocumentV2) => void): Promise<OverlayDocumentV2> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await store.read();
    try {
      return await store.mutate(current.revision, mutation);
    } catch (error) {
      if (!(error instanceof StoreConflictError) || attempt === 2) throw error;
    }
  }
  throw new Error("Unable to serialize internal overlay mutation.");
}

function expectedStateRevision(request: express.Request, body: Record<string, unknown>): number {
  const header = request.header("if-match")?.replaceAll('"', "");
  const value = header ?? body.expected_revision;
  const revision = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(revision) || revision < 0) throw new RequestError(428, "An If-Match or expected_revision state revision is required.");
  return revision;
}

function revisionEtag(revision: number): string {
  return `"${revision}"`;
}

function uniquePresetId(document: OverlayDocumentV2, seed: string): string {
  const base = slugify(seed) || "preset";
  let id = base;
  let counter = 2;
  while (document.presets.some((preset) => preset.id === id) || document.templates.some((template) => template.id === id)) {
    id = `${base}-${counter}`;
    counter += 1;
  }
  return validId(id.slice(0, 64).replace(/-+$/, ""));
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function validId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(value) || value.length > 64) {
    throw new RequestError(400, "IDs and slugs must use 2-64 lowercase letters, numbers, or hyphens.");
  }
  return value;
}

function validSourceKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{20,64}$/.test(value)) throw new RequestError(404, "Overlay source not found.");
  return value;
}

function validSlsId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new RequestError(400, "Stream profile IDs must use letters, numbers, underscores, or hyphens.");
  }
  return value;
}

function requiredText(value: unknown, max: number, label: string): string {
  const text = cleanText(value, max);
  if (!text) throw new RequestError(400, `${label} is required.`);
  return text;
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireManagementAuth(config: FrameOverlaysConfig) {
  return (request: express.Request, response: express.Response, next: express.NextFunction): void => {
    if (!config.username || !config.password) return next();
    const credentials = readBasicCredentials(request.header("authorization"));
    if (credentials && safeEqual(credentials.username, config.username) && safeEqual(credentials.password, config.password)) return next();
    response.setHeader("WWW-Authenticate", 'Basic realm="FRAME Overlays", charset="UTF-8"');
    response.status(401).send("Authentication required.");
  };
}

function requireInternalAuth(config: FrameOverlaysConfig) {
  return (request: express.Request, response: express.Response, next: express.NextFunction): void => {
    const authorization = request.header("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (token && safeEqual(token, config.slsApiKey)) return next();
    response.status(401).json({ error: "Internal service authentication required." });
  };
}

function readBasicCredentials(authorization: string | undefined): { username: string; password: string } | null {
  if (!authorization?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator < 0 ? null : { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

export class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
