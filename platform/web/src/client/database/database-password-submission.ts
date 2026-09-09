import type { UiRequestReadModel } from "../../shared/protocol/events.ts";

/** A submitted password may answer one matching broker request, never a general credential/source prompt. */
export function databasePasswordSubmission(
  password: string,
  input: { target: string; operationId: string; generation: number; readOnly: boolean },
) {
  if (password.length > 4096 || /[\u0000-\u001f\u007f]/u.test(password))
    throw new Error("Password must be at most 4,096 characters and contain no control characters.");
  const url = new URL(input.target);
  const driver =
    url.protocol === "postgres:" || url.protocol === "postgresql:"
      ? "postgres"
      : url.protocol === "mysql:"
        ? "mysql"
        : url.protocol === "mongodb:" || url.protocol === "mongodb+srv:"
          ? "mongodb"
          : url.protocol === "redis:" || url.protocol === "rediss:"
            ? "redis"
            : undefined;
  if (!driver || url.password || !url.hostname || (!url.username && driver !== "redis"))
    throw new Error("Enter a username to use a database password.");
  const target = {
    driver,
    username: decodeURIComponent(url.username) || "default",
    hostname: url.hostname.toLowerCase().replace(/\.$/u, ""),
    port: Number(
      url.port || (driver === "postgres" ? 5432 : driver === "mysql" ? 3306 : driver === "redis" ? 6379 : 27017),
    ),
    database: url.pathname.replace(/^\//u, ""),
  };
  let secret: string | undefined = password;
  password = "";
  let answered: string | undefined;
  const matches = (request: UiRequestReadModel) =>
    (secret !== undefined || answered === request.requestId) &&
    request.owned &&
    request.surface === "database" &&
    request.operationId === input.operationId &&
    request.payload.sessionGeneration === input.generation &&
    request.method === "input" &&
    request.payload.context === "stateql-credential" &&
    request.payload.credentialKind === "password" &&
    request.payload.inputType === "password" &&
    request.payload.access === (input.readOnly ? "read" : "write") &&
    Object.entries(target).every(([key, value]) => request.payload[key] === value) &&
    // A consumed request stays consumed while its close event is in flight; renewal must not reopen its password UI.
    (answered === request.requestId || !request.expiresAt || Date.parse(request.expiresAt) > Date.now());
  return {
    matches,
    clear() {
      secret = undefined;
      answered = undefined;
    },
    async answer(
      request: UiRequestReadModel,
      send: (request: UiRequestReadModel, body: { value: string }) => Promise<void>,
    ) {
      if (!matches(request) || answered !== undefined) return false;
      const value = secret!;
      secret = undefined;
      answered = request.requestId;
      await send(request, { value });
      return true;
    },
  };
}
