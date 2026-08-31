/**
 * 后端统一响应契约。
 *
 * 每个 JSON 端点都回 `{code, msg, data, requestId}`：`code === 0` 表示成功，
 * 业务数据只在 `data` 里；其余取值的前若干位就是 HTTP 状态码（40100 对应 401）。
 * 唯一的例外是 `/healthz`——它服务于反向代理和外部监控，保持裸响应。
 */

/** 成功码。与后端 `app.core.api_contract.ApiCode.OK` 对齐。 */
export const API_CODE_OK = 0;

export interface ApiEnvelope<T = unknown> {
  code: number;
  msg: string;
  data: T;
  /** 同 `X-Request-Id` 响应头，报障时把它给到后端即可定位单次请求。 */
  requestId: string;
}

/** 列表端点的 `data`。分页端点在此之上再加 `page` / `pageSize`。 */
export interface ApiCollection<T> {
  items: T[];
  total: number;
}

/** 422 的 `data.errors`：`msg` 已被后端汇总进信封的 `msg`，这里是逐字段明细。 */
export interface ApiValidationError {
  loc?: (string | number)[];
  msg?: string;
  type?: string;
}

export interface ApiValidationData {
  errors?: ApiValidationError[];
}

export interface SystemHealth {
  status: string;
  database?: string;
  version?: string;
  time?: string;
}
