declare module "express" {
  export type Request = {
    readonly path: string;
  };

  export type Response = {
    status(code: number): Response;
    type(contentType: string): Response;
    json(body: unknown): Response;
    send(body: string): Response;
  };

  export type RequestHandler = (request: Request, response: Response) => void;

  export type Express = {
    get(path: string, handler: RequestHandler): void;
    listen(port: number, callback?: () => void): unknown;
  };

  type ExpressFactory = {
    (): Express;
    json(): RequestHandler;
  };

  const express: ExpressFactory;

  export default express;
}
