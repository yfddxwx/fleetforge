/** FleetForge unified event schema version. Bump on breaking envelope/payload changes. */
export const SCHEMA_VERSION = 1 as const;

export type SchemaVersion = typeof SCHEMA_VERSION;
