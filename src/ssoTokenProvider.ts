import { AWS, AwsTypes, colors, SsoOidc } from "../deps.ts";

/**
 * Last refresh attempt time to ensure refresh is not attempted more than once every 30 seconds.
 */
const lastRefreshAttemptTime = new Date(0);

/**
 * The time window (5 mins) that SDK will treat the SSO token expires in before the defined expiration date in token.
 * This is needed because server side may have invalidated the token before the defined expiration date.
 */
const EXPIRE_WINDOW_MS = 5 * 60 * 1000;

const validateTokenKey = (key: string, value: unknown, forRefresh = false) => {
  if (typeof value === "undefined") {
    throw new TokenError(
      `Value not present for '${key}' in SSO Token${
        forRefresh ? ". Cannot refresh" : ""
      }.`,
    );
  }
};

const validateTokenExpiry = (token: AwsTypes.TokenIdentity) => {
  if (token.expiration && token.expiration.getTime() < Date.now()) {
    throw new TokenError(`Token is expired.`);
  }
};

const writeSSOTokenToFile = (id: string, ssoToken: AWS.SSOToken) => {
  const tokenFilepath = AWS.getSSOTokenFilepath(id);
  const tokenString = JSON.stringify(ssoToken, null, 2);
  return Deno.writeTextFile(tokenFilepath, tokenString);
};

const getNewSsoOidcToken = (ssoToken: AWS.SSOToken, ssoRegion: string) => {
  const ssoOidcClient = new SsoOidc.SSOOIDCClient({ region: ssoRegion });
  console.log(ssoToken, ssoRegion);

  return ssoOidcClient.send(
    new SsoOidc.CreateTokenCommand({
      clientId: ssoToken.clientId,
      clientSecret: ssoToken.clientSecret,
      refreshToken: ssoToken.refreshToken,
      grantType: "refresh_token",
    }),
  );
};

export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}

/**
 * Creates a token provider that will read from SSO token cache or ssoOidc.createToken() call.
 */
export const fromSso = ({ ssoSessionName, ssoRegion }: {
  ssoSessionName: string;
  ssoRegion: string;
}): AwsTypes.TokenIdentityProvider =>
async () => {
  let ssoToken: AWS.SSOToken;

  try {
    ssoToken = await AWS.getSSOTokenFromFile(ssoSessionName);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new TokenError(
        `SSO token not found. Run ${
          colors.underline("aws sso login --sso-session " + ssoSessionName)
        } first.`,
      );
    }

    throw e;
  }

  validateTokenKey("accessToken", ssoToken.accessToken);
  validateTokenKey("expiresAt", ssoToken.expiresAt);

  const existingToken: AwsTypes.TokenIdentity = {
    token: ssoToken.accessToken,
    expiration: new Date(ssoToken.expiresAt),
  };

  if (existingToken.expiration!.getTime() - Date.now() > EXPIRE_WINDOW_MS) {
    // Token is valid and not expired.
    return existingToken;
  }

  // Skip new refresh, if last refresh was done within 30 seconds.
  if (Date.now() - lastRefreshAttemptTime.getTime() < 30 * 1000) {
    /// return existing token if it's still valid.
    validateTokenExpiry(existingToken);
    return existingToken;
  }

  validateTokenKey("clientId", ssoToken.clientId, true);
  validateTokenKey("clientSecret", ssoToken.clientSecret, true);
  validateTokenKey("refreshToken", ssoToken.refreshToken, true);

  try {
    lastRefreshAttemptTime.setTime(Date.now());
    console.log("test1");
    const newSsoOidcToken = await getNewSsoOidcToken(ssoToken, ssoRegion);
    console.log("test2");
    validateTokenKey("accessToken", newSsoOidcToken.accessToken);
    validateTokenKey("expiresIn", newSsoOidcToken.expiresIn);
    const newTokenExpiration = new Date(
      Date.now() + newSsoOidcToken.expiresIn! * 1000,
    );

    try {
      await writeSSOTokenToFile(ssoSessionName, {
        ...ssoToken,
        accessToken: newSsoOidcToken.accessToken!,
        expiresAt: newTokenExpiration.toISOString(),
        refreshToken: newSsoOidcToken.refreshToken,
      });
    } catch (_e) {
      // Swallow error if unable to write token to file.
    }

    return {
      token: newSsoOidcToken.accessToken!,
      expiration: newTokenExpiration,
    };
  } catch (_e) {
    console.log(_e);
    // return existing token if it's still valid.
    validateTokenExpiry(existingToken);
    return existingToken;
  }
};
