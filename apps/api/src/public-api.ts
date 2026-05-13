import type { Express, NextFunction, Request, RequestHandler, Response } from "express";

import type { AppConfig, OperatorIdentity } from "@agent-pool/config";

export type PublicApiOptions = {
  readonly config: AppConfig;
};

export type PublicOperatorRequest = Request & {
  publicOperator?: OperatorIdentity;
};

const PUBLIC_OPERATOR_ID_HEADER = "x-agent-pool-operator-id";

export function registerPublicApiRoutes(app: Express, options: PublicApiOptions): void {
  const requirePublicOperator = createPublicOperatorMiddleware(options.config);

  app.get("/api/public/me", requirePublicOperator, (request: PublicOperatorRequest, response) => {
    response.status(200).json({
      ok: true,
      operator: request.publicOperator,
      authMode: options.config.authMode,
    });
  });
}

export function createPublicOperatorMiddleware(config: AppConfig): RequestHandler {
  return (request: PublicOperatorRequest, response: Response, next?: NextFunction): void => {
    const operatorId = readHeader(request, PUBLIC_OPERATOR_ID_HEADER);

    if (!operatorId) {
      response.status(401).json(publicError("unauthenticated", "operator auth required"));
      return;
    }

    if (operatorId !== config.operator.id) {
      response.status(403).json(publicError("forbidden", "operator auth invalid"));
      return;
    }

    request.publicOperator = config.operator;
    next?.();
  };
}

export function publicError(code: string, message: string): { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

function readHeader(request: Request, name: string): string | null {
  const raw = request.headers?.[name];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value && value.length > 0 ? value : null;
}
