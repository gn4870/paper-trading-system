import type {
  ApiErrorResponse,
  BootstrapResponse,
  Order,
  PlaceOrderRequest,
  Trade
} from "@paper/shared";

export interface PlaceOrderResponse {
  order: Order;
  trades: Trade[];
  replayed: boolean;
}

export interface CancelOrderResponse {
  order: Order;
}

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export interface HttpClientOptions {
  fetchImpl?: typeof fetch;
}

const isApiErrorResponse = (value: unknown): value is ApiErrorResponse => {
  if (typeof value !== "object" || value === null || !("error" in value))
    return false;
  const error = value.error;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    "requestId" in error &&
    typeof error.code === "string" &&
    typeof error.message === "string" &&
    typeof error.requestId === "string"
  );
};

const parseJson = (body: string): unknown | undefined => {
  if (body.trim() === "") return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
};

export class HttpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  get<T>(path: string, query?: Record<string, string>): Promise<T> {
    return this.request<T>("GET", path, undefined, query);
  }

  post<T>(
    path: string,
    body?: unknown,
    query?: Record<string, string>
  ): Promise<T> {
    return this.request<T>("POST", path, body, query);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  bootstrap(): Promise<BootstrapResponse> {
    return this.get<BootstrapResponse>("/api/bootstrap");
  }

  placeOrder(order: PlaceOrderRequest): Promise<PlaceOrderResponse> {
    return this.post<PlaceOrderResponse>("/api/orders", order);
  }

  cancelOrder(orderId: string): Promise<CancelOrderResponse> {
    return this.delete<CancelOrderResponse>(
      `/api/orders/${encodeURIComponent(orderId)}`
    );
  }

  private async request<T>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    query?: Record<string, string>
  ): Promise<T> {
    const url = new URL(
      path,
      globalThis.location?.origin ?? "http://localhost"
    );
    if (query !== undefined) url.search = new URLSearchParams(query).toString();
    const requestInit: RequestInit = {
      method,
      credentials: "include"
    };
    if (body !== undefined) {
      requestInit.headers = { "content-type": "application/json" };
      requestInit.body = JSON.stringify(body);
    }
    const request = new Request(url, requestInit);

    try {
      const response = await this.fetchImpl(request);
      if (response.status === 204) return undefined as T;
      const rawBody = await response.text();
      const payload = parseJson(rawBody);
      if (response.ok) return payload as T;
      if (isApiErrorResponse(payload)) {
        throw new ApiClientError(
          response.status,
          payload.error.code,
          payload.error.message,
          payload.error.requestId
        );
      }
      throw new ApiClientError(
        response.status,
        "HTTP_ERROR",
        `请求失败（HTTP ${response.status}），请稍后重试。`
      );
    } catch (error: unknown) {
      if (error instanceof ApiClientError) throw error;
      throw new ApiClientError(
        0,
        "NETWORK_ERROR",
        "网络连接失败，请检查网络后重试。"
      );
    }
  }
}
