import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

test("runtime schema/default copies and the canonical V2 example stay synchronized and valid", async () => {
  const [runtimeSchemaText, canonicalSchemaText, runtimeDefaultText, canonicalDefaultText, exampleText] = await Promise.all([
    readFile("config/overlay-presets.schema.json", "utf8"),
    readFile("../../docs/schemas/overlay-presets.schema.json", "utf8"),
    readFile("config/overlay-presets.default.json", "utf8"),
    readFile("../../docs/schemas/overlay-presets.default.json", "utf8"),
    readFile("../../docs/schemas/overlay-presets.example.json", "utf8"),
  ]);
  assert.equal(runtimeSchemaText, canonicalSchemaText);
  assert.equal(runtimeDefaultText, canonicalDefaultText);
  const ajv = new Ajv2020({ allErrors:true, strict:false });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(runtimeSchemaText));
  assert.equal(validate(JSON.parse(runtimeDefaultText)), true, JSON.stringify(validate.errors));
  assert.equal(validate(JSON.parse(exampleText)), true, JSON.stringify(validate.errors));
});
