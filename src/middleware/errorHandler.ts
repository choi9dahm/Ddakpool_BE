import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorHandler(
  error: FastifyError | AppError,
  _request: FastifyRequest,
  reply: FastifyReply
) {
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      error: error.code ?? "app_error",
      message: error.message,
    });
  }

  const statusCode = error.statusCode ?? 500;
  return reply.status(statusCode).send({
    error: "internal_error",
    message:
      statusCode >= 500
        ? "서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요."
        : error.message,
  });
}
