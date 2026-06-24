import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export async function storeFixtureOptions(statePath) {
  const schema = JSON.parse(await readFile("config/overlay-presets.schema.json", "utf8"));
  const stockDocument = JSON.parse(await readFile("config/overlay-presets.default.json", "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  return {
    statePath,
    stockDocument,
    validate: (document) => validate(document),
    validationErrors: () => JSON.stringify(validate.errors),
  };
}
