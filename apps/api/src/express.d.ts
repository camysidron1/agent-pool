declare module "express" {
  export type Request = {
    readonly path: string;
    readonly method: string;
    readonly headers?: Record<string, string | readonly string[] | undefined>;
    internalServiceSubject?: "internal-service";
  };

  export type Response = {
    status(code: number): Response;
    type(contentType: string): Response;
    json(body: unknown): Response;
    send(body: string): Response;
  };

  export type NextFunction = () => void;

  export type RequestHandler = (request: Request, response: Response, next?: NextFunction) => void;

  export type Express = {
    use(handler: RequestHandler): void;
    get(path: string, ...handlers: RequestHandler[]): void;
    post(path: string, ...handlers: RequestHandler[]): void;
    listen(port: number, callback?: () => void): unknown;
  };

  type ExpressFactory = {
    (): Express;
    json(): RequestHandler;
  };

  const express: ExpressFactory;

  export default express;
}
