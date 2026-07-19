declare module 'jmespath' {
  export function compile(expression: string): unknown;
  export function search(data: unknown, expression: string): unknown;
}
