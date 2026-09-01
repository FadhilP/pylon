/**
 * Storage-agnostic primitive package-setting descriptors. Descriptors are data only:
 * packages own their config paths and decide when to persist them.
 */
export const PACKAGE_SETTINGS_DESCRIPTOR_VERSION = 1 as const;

export type PackageSettingApplyTiming = "immediate" | "next-operation" | "next-session" | "reload";
export type PackageSettingPrimitive = boolean | number | string | string[];

type FieldBase<T extends string, V> = {
  version: typeof PACKAGE_SETTINGS_DESCRIPTOR_VERSION;
  key: string;
  label: string;
  type: T;
  defaultValue: V;
  description?: string;
  unit?: string;
  step?: number;
  /** Optional environment fallback used only when no persisted value exists. */
  env?: string;
  /** Informational metadata for settings surfaces; it has no runtime callback. */
  apply: PackageSettingApplyTiming;
};

export type BooleanPackageSettingField = FieldBase<"boolean", boolean>;
export type IntegerPackageSettingField = FieldBase<"integer", number> & { min?: number; max?: number };
export type NumberPackageSettingField = FieldBase<"number", number> & { min?: number; max?: number };
export type EnumPackageSettingField = FieldBase<"enum", string> & { choices: readonly string[] };
/** For string lists, min and max bound the number of list entries. */
export type StringListPackageSettingField = FieldBase<"string-list", string[]> & {
  choices?: readonly string[];
  min?: number;
  max?: number;
};

export type PackageSettingField =
  | BooleanPackageSettingField
  | IntegerPackageSettingField
  | NumberPackageSettingField
  | EnumPackageSettingField
  | StringListPackageSettingField;

export type PackageSettingValue<F extends PackageSettingField> = F["defaultValue"];

export interface PackageSettingsDescriptor {
  version: typeof PACKAGE_SETTINGS_DESCRIPTOR_VERSION;
  packageId: string;
  fields: readonly PackageSettingField[];
}

export type GenericPackageSettingReadField =
  | (Omit<BooleanPackageSettingField, "env"> & { value: boolean })
  | (Omit<IntegerPackageSettingField, "env"> & { value: number })
  | (Omit<NumberPackageSettingField, "env"> & { value: number })
  | (Omit<EnumPackageSettingField, "env"> & { value: string })
  | (Omit<StringListPackageSettingField, "env"> & { value: string[] });
export interface GenericPackageSettingsReadModel {
  kind: "generic";
  packageId: string;
  fields: GenericPackageSettingReadField[];
}

const MAX_PACKAGE_ID_LENGTH = 128;
const MAX_KEY_LENGTH = 128;
const MAX_LABEL_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_UNIT_LENGTH = 64;
const MAX_ENV_LENGTH = 200;
const MAX_FIELDS = 50;
const MAX_CHOICES = 100;
const MAX_LIST_ITEMS = 100;
const MAX_STRING_LENGTH = 500;
const MAX_ABSOLUTE_NUMBER = 1_000_000_000;
const packageIdPattern = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;
const applyTimings = new Set<PackageSettingApplyTiming>(["immediate", "next-operation", "next-session", "reload"]);

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function boundedString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= maximum && (allowEmpty || value.length > 0);
}

function boundedNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_ABSOLUTE_NUMBER;
}

function validChoices(value: unknown, required: boolean): boolean {
  return (
    (value === undefined && !required) ||
    (Array.isArray(value) &&
      value.length > 0 &&
      value.length <= MAX_CHOICES &&
      value.every(item => boundedString(item, MAX_STRING_LENGTH)) &&
      new Set(value).size === value.length)
  );
}

function validBounds(field: Record<string, unknown>, integer: boolean): boolean {
  const min = field.min;
  const max = field.max;
  const step = field.step;
  const number = (value: unknown) => boundedNumber(value) && (!integer || Number.isSafeInteger(value));
  return (
    (min === undefined || number(min)) &&
    (max === undefined || number(max)) &&
    (min === undefined || max === undefined || (min as number) <= (max as number)) &&
    (step === undefined || (number(step) && (step as number) > 0))
  );
}

/** Validates a data-only descriptor before it is used by a package. */
export function validPackageSettingsDescriptor(value: unknown): value is PackageSettingsDescriptor {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["version", "packageId", "fields"]) ||
    value.version !== PACKAGE_SETTINGS_DESCRIPTOR_VERSION ||
    !boundedString(value.packageId, MAX_PACKAGE_ID_LENGTH) ||
    !packageIdPattern.test(value.packageId) ||
    !Array.isArray(value.fields) ||
    value.fields.length > MAX_FIELDS
  )
    return false;
  const keys = new Set<string>();
  return value.fields.every(field => {
    if (!validPackageSettingField(field) || keys.has(field.key)) return false;
    keys.add(field.key);
    return true;
  });
}

/** Defines an inert, storage-agnostic descriptor and rejects malformed metadata. */
export function definePackageSettings<T extends PackageSettingsDescriptor>(descriptor: T): T {
  if (!validPackageSettingsDescriptor(descriptor)) throw new Error("invalid package settings descriptor");
  return descriptor;
}

/** Validates one data-only primitive field. */
export function validPackageSettingField(value: unknown): value is PackageSettingField {
  if (!plainRecord(value)) return false;
  const base = ["version", "key", "label", "type", "defaultValue", "description", "unit", "step", "env", "apply"];
  if (
    !exactKeys(value, [...base, "min", "max", "choices"]) ||
    value.version !== PACKAGE_SETTINGS_DESCRIPTOR_VERSION ||
    !boundedString(value.key, MAX_KEY_LENGTH) ||
    !boundedString(value.label, MAX_LABEL_LENGTH) ||
    (value.description !== undefined && !boundedString(value.description, MAX_DESCRIPTION_LENGTH, true)) ||
    (value.unit !== undefined && !boundedString(value.unit, MAX_UNIT_LENGTH)) ||
    (value.env !== undefined && !boundedString(value.env, MAX_ENV_LENGTH)) ||
    !applyTimings.has(value.apply as PackageSettingApplyTiming)
  )
    return false;

  if (value.type === "boolean") {
    return value.min === undefined && value.max === undefined && value.choices === undefined && value.step === undefined && typeof value.defaultValue === "boolean";
  }
  if (value.type === "integer") {
    return value.choices === undefined && validBounds(value, true) && validPackageSettingValue(value as IntegerPackageSettingField, value.defaultValue);
  }
  if (value.type === "number") {
    return value.choices === undefined && validBounds(value, false) && validPackageSettingValue(value as NumberPackageSettingField, value.defaultValue);
  }
  if (value.type === "enum") {
    return value.min === undefined && value.max === undefined && value.step === undefined && Boolean(validChoices(value.choices, true)) && validPackageSettingValue(value as EnumPackageSettingField, value.defaultValue);
  }
  if (value.type === "string-list") {
    return (
      value.step === undefined &&
      validBounds(value, true) &&
      validChoices(value.choices, false) !== false &&
      validPackageSettingValue(value as StringListPackageSettingField, value.defaultValue)
    );
  }
  return false;
}

function bounded(value: number, field: IntegerPackageSettingField | NumberPackageSettingField): boolean {
  return (field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max);
}

/** Validates values as they are represented in persisted config and web requests. */
export function validPackageSettingValue(field: PackageSettingField, value: unknown): boolean {
  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "integer") return Number.isSafeInteger(value) && Math.abs(value as number) <= MAX_ABSOLUTE_NUMBER && bounded(value as number, field);
  if (field.type === "number") return boundedNumber(value) && bounded(value, field);
  if (field.type === "enum") return typeof value === "string" && field.choices.includes(value);
  return (
    Array.isArray(value) &&
    (field.min === undefined || value.length >= field.min) &&
    (field.max === undefined || value.length <= field.max) &&
    value.length <= MAX_LIST_ITEMS &&
    value.every(item => typeof item === "string" && item.length <= MAX_STRING_LENGTH && (!field.choices || field.choices.includes(item))) &&
    new Set(value).size === value.length
  );
}

/** Parses a primitive value, including the string form used by environment variables. */
export function parsePackageSettingValue<F extends PackageSettingField>(
  field: F,
  value: unknown,
): PackageSettingValue<F> | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown = value;
  if (field.type === "boolean" && typeof value === "string") {
    if (value === "true" || value === "1") parsed = true;
    else if (value === "false" || value === "0") parsed = false;
  } else if ((field.type === "integer" || field.type === "number") && typeof value === "string") {
    parsed = Number(value);
  } else if (field.type === "string-list" && typeof value === "string") {
    parsed = value.split(",").map(item => item.trim());
  }
  return validPackageSettingValue(field, parsed) ? (parsed as PackageSettingValue<F>) : undefined;
}

/**
 * Resolves a setting without knowing where it is stored. A valid persisted value wins;
 * otherwise the descriptor's optional environment variable is parsed before its default.
 */
export function effectivePackageSettingValue<F extends PackageSettingField>(
  field: F,
  persisted: unknown,
  environment: Record<string, string | undefined> = process.env,
): PackageSettingValue<F> {
  if (persisted !== undefined) {
    const stored = parsePackageSettingValue(field, persisted);
    if (stored !== undefined) return stored;
    throw new Error(`${field.key} has an invalid value`);
  }
  if (field.env) {
    const fallback = parsePackageSettingValue(field, environment[field.env]);
    if (fallback !== undefined) return fallback;
    if (environment[field.env] !== undefined) throw new Error(`${field.env} has an invalid value`);
  }
  return field.defaultValue as PackageSettingValue<F>;
}

/** Produces the transport-safe effective read model; environment variable names stay private. */
export function effectivePackageSettingsReadModel(
  descriptor: PackageSettingsDescriptor,
  persisted: Record<string, unknown> = {},
  environment: Record<string, string | undefined> = process.env,
): GenericPackageSettingsReadModel {
  if (!validPackageSettingsDescriptor(descriptor)) throw new Error("invalid package settings descriptor");
  if (!plainRecord(persisted)) throw new Error("package settings config must be an object");
  return {
    kind: "generic",
    packageId: descriptor.packageId,
    fields: descriptor.fields.map(field => {
      const { env: _env, ...publicField } = field;
      const value = effectivePackageSettingValue(field, persisted[field.key], environment);
      return {
        ...publicField,
        defaultValue: Array.isArray(publicField.defaultValue) ? [...publicField.defaultValue] : publicField.defaultValue,
        value: Array.isArray(value) ? [...value] : value,
      } as GenericPackageSettingReadField;
    }),
  };
}

/**
 * Extracts validated values from a generic update. Field metadata is deliberately ignored:
 * the package's descriptor is the authority for keys, types, ranges, and choices.
 */
export function extractPackageSettingsUpdate(
  descriptor: PackageSettingsDescriptor,
  update: unknown,
): Record<string, PackageSettingPrimitive> {
  if (!validPackageSettingsDescriptor(descriptor)) throw new Error("invalid package settings descriptor");
  if (!plainRecord(update) || update.kind !== "generic" || update.packageId !== descriptor.packageId || !Array.isArray(update.fields)) {
    throw new Error("invalid generic package settings update");
  }
  if (update.fields.length !== descriptor.fields.length) throw new Error("invalid generic package settings update");
  const submitted = new Map<string, unknown>();
  const allowedFieldKeys = [
    "version", "key", "label", "type", "defaultValue", "value", "description", "unit", "step", "min", "max", "choices", "apply",
  ];
  for (const field of update.fields) {
    if (!plainRecord(field) || !exactKeys(field, allowedFieldKeys) || typeof field.key !== "string" || !("value" in field)) {
      throw new Error("invalid generic package settings update");
    }
    if (submitted.has(field.key)) throw new Error("invalid generic package settings update");
    submitted.set(field.key, field.value);
  }
  const values: Record<string, PackageSettingPrimitive> = {};
  for (const field of descriptor.fields) {
    const value = submitted.get(field.key);
    if (!submitted.has(field.key) || !validPackageSettingValue(field, value)) {
      throw new Error(`${field.key} has an invalid value`);
    }
    values[field.key] = Array.isArray(value) ? [...value] : (value as boolean | number | string);
  }
  return values;
}
