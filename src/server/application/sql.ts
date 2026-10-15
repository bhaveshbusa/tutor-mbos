export interface Sql {
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  exec(text: string): Promise<void>;
}

export interface SqlConnection extends Sql {
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
}
