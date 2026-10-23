import type { IncomingMessage, ServerResponse } from "node:http";

export interface SecurityHeadersOptions {
  contentSecurityPolicy?: string | false | undefined;
  strictTransportSecurity?: string | false | undefined;
  xFrameOptions?: string | false | undefined;
  xContentTypeOptions?: string | false | undefined;
  xXssProtection?: string | false | undefined;
  referrerPolicy?: string | false | undefined;
  permissionsPolicy?: string | false | undefined;
  crossOriginOpenerPolicy?: string | false | undefined;
  crossOriginResourcePolicy?: string | false | undefined;
}

export const DEFAULT_SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' ws: wss: https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "X-XSS-Protection": "0",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

/**
 * Applies production-grade security headers adhering to Helmet and OWASP standards.
 */
export function applySecurityHeaders(
  res: ServerResponse,
  options: SecurityHeadersOptions = {},
): void {
  const headers = { ...DEFAULT_SECURITY_HEADERS };

  if (options.contentSecurityPolicy !== undefined) {
    if (options.contentSecurityPolicy === false) {
      delete headers["Content-Security-Policy"];
    } else {
      headers["Content-Security-Policy"] = options.contentSecurityPolicy;
    }
  }

  if (options.strictTransportSecurity !== undefined) {
    if (options.strictTransportSecurity === false) {
      delete headers["Strict-Transport-Security"];
    } else {
      headers["Strict-Transport-Security"] = options.strictTransportSecurity;
    }
  }

  if (options.xFrameOptions !== undefined) {
    if (options.xFrameOptions === false) {
      delete headers["X-Frame-Options"];
    } else {
      headers["X-Frame-Options"] = options.xFrameOptions;
    }
  }

  if (options.xContentTypeOptions !== undefined) {
    if (options.xContentTypeOptions === false) {
      delete headers["X-Content-Type-Options"];
    } else {
      headers["X-Content-Type-Options"] = options.xContentTypeOptions;
    }
  }

  if (options.xXssProtection !== undefined) {
    if (options.xXssProtection === false) {
      delete headers["X-XSS-Protection"];
    } else {
      headers["X-XSS-Protection"] = options.xXssProtection;
    }
  }

  if (options.referrerPolicy !== undefined) {
    if (options.referrerPolicy === false) {
      delete headers["Referrer-Policy"];
    } else {
      headers["Referrer-Policy"] = options.referrerPolicy;
    }
  }

  if (options.permissionsPolicy !== undefined) {
    if (options.permissionsPolicy === false) {
      delete headers["Permissions-Policy"];
    } else {
      headers["Permissions-Policy"] = options.permissionsPolicy;
    }
  }

  if (options.crossOriginOpenerPolicy !== undefined) {
    if (options.crossOriginOpenerPolicy === false) {
      delete headers["Cross-Origin-Opener-Policy"];
    } else {
      headers["Cross-Origin-Opener-Policy"] = options.crossOriginOpenerPolicy;
    }
  }

  if (options.crossOriginResourcePolicy !== undefined) {
    if (options.crossOriginResourcePolicy === false) {
      delete headers["Cross-Origin-Resource-Policy"];
    } else {
      headers["Cross-Origin-Resource-Policy"] = options.crossOriginResourcePolicy;
    }
  }

  for (const [headerName, headerValue] of Object.entries(headers)) {
    res.setHeader(headerName, headerValue);
  }
}

/**
 * Creates middleware to automatically attach security headers to responses.
 */
export function createSecurityHeadersMiddleware(
  options: SecurityHeadersOptions = {},
): (req: IncomingMessage, res: ServerResponse, next?: () => void) => void {
  return (_req: IncomingMessage, res: ServerResponse, next?: () => void) => {
    applySecurityHeaders(res, options);
    if (next) {
      next();
    }
  };
}
