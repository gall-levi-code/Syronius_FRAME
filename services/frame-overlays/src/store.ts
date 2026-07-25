import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  clone,
  createSourceKey,
  dataSourceForType,
  isLegacyPresetDocument,
  isOverlayDocumentV2,
  SCHEMA_VERSION,
  type BuiltinTemplate,
  type LegacyPresetDocument,
  type OverlayDesign,
  type OverlayDocumentV2,
  type OverlayType,
  type UserPreset,
} from "./model.js";

export class StoreConflictError extends Error {
  readonly status = 409;

  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`State changed since it was loaded (expected revision ${expectedRevision}, current revision ${actualRevision}).`);
  }
}

export class StoreValidationError extends Error {
  readonly status = 400;
}

export interface OverlayStoreOptions {
  statePath: string;
  stockDocument: OverlayDocumentV2;
  validate: (document: unknown) => boolean;
  validationErrors: () => string;
  now?: () => Date;
}

export class OverlayStore {
  readonly statePath: string;
  private readonly stockDocument: OverlayDocumentV2;
  private readonly validateDocument: (document: unknown) => boolean;
  private readonly validationErrors: () => string;
  private readonly now: () => Date;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(options: OverlayStoreOptions) {
    this.statePath = options.statePath;
    this.stockDocument = clone(options.stockDocument);
    this.validateDocument = options.validate;
    this.validationErrors = options.validationErrors;
    this.now = options.now ?? (() => new Date());
  }

  async init(): Promise<OverlayDocumentV2> {
    await mkdir(path.dirname(this.statePath), { recursive: true });
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.statePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.atomicWrite(this.stockDocument, false);
      return this.read();
    }

    if (isLegacyPresetDocument(raw)) {
      const migrated = migrateLegacyDocument(raw, this.stockDocument, this.now());
      const migrationBackup = `${this.statePath}.v1-${safeTimestamp(this.now())}.bak`;
      await copyFile(this.statePath, migrationBackup);
      await this.atomicWrite(migrated, false);
    } else if (isOverlayDocumentV2(raw)) {
      const synchronized = synchronizeV2Document(raw, this.stockDocument);
      const changed = clampPersistedRanges(synchronized, this.now()) || JSON.stringify(synchronized) !== JSON.stringify(raw);
      if (changed) {
        synchronized.revision = raw.revision + 1;
        // ponytail: current templates define the supported design surface; obsolete saved keys are pruned at startup.
        this.assertValid(synchronized);
        await this.atomicWrite(synchronized, true);
      }
      this.assertValid(synchronized);
    }
    return this.read();
  }

  async read(): Promise<OverlayDocumentV2> {
    const document = JSON.parse(await readFile(this.statePath, "utf8")) as unknown;
    this.assertValid(document);
    this.assertBuiltinTemplates(document);
    this.assertTypeBindings(document);
    return document;
  }

  async mutate(
    expectedRevision: number,
    mutation: (document: OverlayDocumentV2) => void | Promise<void>,
  ): Promise<OverlayDocumentV2> {
    let result!: OverlayDocumentV2;
    const operation = async () => {
      const document = await this.read();
      if (document.revision !== expectedRevision) {
        throw new StoreConflictError(expectedRevision, document.revision);
      }
      await mutation(document);
      document.revision += 1;
      this.assertValid(document);
      this.assertBuiltinTemplates(document);
      this.assertTypeBindings(document);
      await this.atomicWrite(document, true);
      result = clone(document);
    };
    const completion = this.writeTail.then(operation, operation);
    this.writeTail = completion.then(() => undefined, () => undefined);
    await completion;
    return result;
  }

  private assertValid(document: unknown): asserts document is OverlayDocumentV2 {
    if (!isOverlayDocumentV2(document) || !this.validateDocument(document)) {
      throw new StoreValidationError(`Overlay state is invalid: ${this.validationErrors()}`);
    }
  }

  private assertBuiltinTemplates(document: OverlayDocumentV2): void {
    if (document.default_template_id !== this.stockDocument.default_template_id) {
      throw new Error("The default built-in template identity is immutable.");
    }
    if (JSON.stringify(document.default_template_ids) !== JSON.stringify(this.stockDocument.default_template_ids)) {
      throw new Error("The per-type default template identities are immutable.");
    }
    if (JSON.stringify(document.templates) !== JSON.stringify(this.stockDocument.templates)) {
      throw new Error("Built-in templates are immutable and must match the shipped catalog.");
    }
  }

  private assertTypeBindings(document: OverlayDocumentV2): void {
    for (const [type, templateId] of Object.entries(document.default_template_ids)) {
      const template = document.templates.find((candidate) => candidate.id === templateId);
      if (!template || template.type !== type) throw new Error(`Default template ${templateId} must belong to overlay type ${type}.`);
    }
    for (const preset of document.presets) {
      const template = document.templates.find((candidate) => candidate.id === preset.template_id);
      if (!template || template.type !== preset.type) throw new Error(`Preset ${preset.id} must retain its template overlay type.`);
    }
    for (const source of document.sources) {
      const preset = document.presets.find((candidate) => candidate.id === source.preset_id);
      if (!preset) throw new Error(`Source ${source.id} references a missing preset.`);
      const expectedKind = preset.type === "connectivity" ? "stream" : preset.type;
      if (source.data_source.kind !== expectedKind) throw new Error(`Source ${source.id} data source does not match preset type ${preset.type}.`);
    }
  }

  private async atomicWrite(document: OverlayDocumentV2, backup: boolean): Promise<void> {
    const temporary = `${this.statePath}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    if (backup) {
      try {
        await copyFile(this.statePath, `${this.statePath}.bak`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await rename(temporary, this.statePath);
  }
}

export function migrateLegacyDocument(
  legacy: LegacyPresetDocument,
  stock: OverlayDocumentV2,
  now: Date,
): OverlayDocumentV2 {
  const timestamp = now.toISOString();
  const presets: UserPreset[] = [];
  const sources: OverlayDocumentV2["sources"] = [];
  const legacyAliases: Record<string, string> = {};
  const defaultTemplate = stock.templates.find((template) => template.id === stock.default_template_id) ?? stock.templates[0];
  if (!defaultTemplate) throw new Error("The stock overlay catalog must contain a default template.");

  for (const raw of legacy.presets) {
    const id = String(raw.id ?? "");
    if (!id) continue;
    const type = validOverlayType(raw.type) ? raw.type : "connectivity";
    const rawConfig = objectValue(raw.config);
    const streamProfileId = typeof rawConfig.stream_profile_id === "string" && rawConfig.stream_profile_id
      ? rawConfig.stream_profile_id
      : null;
    delete rawConfig.stream_profile_id;
    const design = {
      name: String(raw.name || id),
      description: typeof raw.description === "string" ? raw.description : undefined,
      tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
      enabled: raw.enabled !== false,
      window_title: typeof raw.window_title === "string" ? raw.window_title : undefined,
      type,
      layout: objectValue(raw.layout),
      theme: objectValue(raw.theme),
      config: rawConfig,
    } as unknown as OverlayDesign;
    const preset: UserPreset = {
      ...design,
      id,
      template_id: type === defaultTemplate.type ? defaultTemplate.id : defaultTemplate.id,
      revision: 1,
      created_at: typeof raw.created_at === "string" ? raw.created_at : timestamp,
      updated_at: typeof raw.updated_at === "string" ? raw.updated_at : timestamp,
    };
    const sourceId = `legacy-${id}`;
    presets.push(preset);
    sources.push({
      id: sourceId,
      slug: id,
      source_key: createSourceKey(),
      display_name: preset.name,
      preset_id: preset.id,
      enabled: preset.enabled,
      data_source: dataSourceForType(type, streamProfileId),
      revision: 1,
      created_at: preset.created_at,
      updated_at: preset.updated_at,
    });
    legacyAliases[id] = sourceId;
  }

  return {
    schema_version: SCHEMA_VERSION,
    revision: 1,
    default_template_id: stock.default_template_id,
    default_template_ids: clone(stock.default_template_ids),
    templates: clone(stock.templates),
    presets,
    sources,
    legacy_aliases: legacyAliases,
  };
}

export function designFromTemplate(template: BuiltinTemplate): OverlayDesign {
  const { id: _id, builtin: _builtin, readonly: _readonly, ...design } = clone(template);
  return design;
}

function synchronizeV2Document(document: OverlayDocumentV2, stock: OverlayDocumentV2): OverlayDocumentV2 {
  const templatesByType = new Map(stock.templates.map((template) => [template.type, template]));
  const presets = document.presets.map((preset) => {
    const template = templatesByType.get(preset.type);
    if (!template) return preset;
    return {
      ...preset,
      layout: pickKnown(objectValue(preset.layout), objectValue(template.layout)),
      theme: pickKnown(objectValue(preset.theme), objectValue(template.theme)),
      config: pickKnown(objectValue(preset.config), objectValue(template.config)),
    } as unknown as UserPreset;
  });
  return {
    ...document,
    default_template_id: stock.default_template_id,
    default_template_ids: clone(stock.default_template_ids),
    templates: clone(stock.templates),
    presets,
  };
}

function validOverlayType(value: unknown): value is OverlayType {
  return value === "connectivity" || value === "upload_progress" || value === "latest_photo";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? clone(value as Record<string, unknown>) : {};
}

function pickKnown(value: Record<string, unknown>, example: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(example).flatMap((key) => key in value ? [[key, value[key]]] : []));
}

function clampPersistedRanges(document: OverlayDocumentV2, now: Date): boolean {
  const timestamp = now.toISOString();
  let changed = false;
  for (const preset of document.presets) {
    const clampPoll = preset.type === "connectivity" && Number(preset.config.poll_ms) < 200;
    const clampCompletionRadius = preset.type === "upload_progress" && Number(preset.theme?.completion_radius_px) > 48;
    if (!clampPoll && !clampCompletionRadius) continue;
    if (clampPoll) preset.config.poll_ms = 200;
    if (clampCompletionRadius) (preset.theme ??= {}).completion_radius_px = 48;
    preset.revision += 1;
    preset.updated_at = timestamp;
    changed = true;
  }
  return changed;
}

function safeTimestamp(date: Date): string {
  return date.toISOString().replaceAll(":", "-");
}
