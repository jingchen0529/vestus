export interface ApiErrorDetail {
  loc?: (string | number)[];
  msg?: string;
  type?: string;
}

export interface ApiErrorResponse {
  detail?: string | ApiErrorDetail[] | Record<string, any>;
  message?: string;
}

export interface SystemHealth {
  status: string;
  database?: string;
  version?: string;
  time?: string;
}
