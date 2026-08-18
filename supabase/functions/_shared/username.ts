// Keep these rules in lockstep with the browser adapter in index.html.
export const USERNAME_AUTH_DOMAIN = "dailyops.invalid";
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

const USERNAME_PATTERN = /^[a-z0-9._-]+$/;
const CONSECUTIVE_SEPARATOR_PATTERN = /[._-]{2}/;

export function normalizeUsername(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Username must be text");
  }

  const username = value.trim().toLowerCase();
  const valid = username.length >= USERNAME_MIN_LENGTH &&
    username.length <= USERNAME_MAX_LENGTH &&
    USERNAME_PATTERN.test(username) &&
    /^[a-z0-9]/.test(username) &&
    /[a-z0-9]$/.test(username) &&
    !CONSECUTIVE_SEPARATOR_PATTERN.test(username);

  if (!valid) {
    throw new Error(
      "Username must be 3-32 characters using letters, numbers, dots, underscores or hyphens; it must start and end with a letter or number.",
    );
  }

  return username;
}

export function usernameToAuthEmail(value: unknown): string {
  return `${normalizeUsername(value)}@${USERNAME_AUTH_DOMAIN}`;
}
