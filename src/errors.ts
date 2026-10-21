// Errors carry a stable `code`; clients translate codes, the message is only a fallback.
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string){
    super(message);
  }
}

export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found`);
export const forbidden = () => new ApiError(403, 'forbidden', 'You do not have access to this');
