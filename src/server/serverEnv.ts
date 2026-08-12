export function serverEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export function requiredServerEnv(name: string): string {
  const value = serverEnv(name);
  if (!value) throw new Error("SERVER_CONFIGURATION_MISSING");
  return value;
}
