declare module "node:sqlite" {
  export type SQLInputValue = null | number | bigint | string | Uint8Array
  export type SQLOutputValue = null | number | bigint | string | Uint8Array

  export interface StatementResultingChanges {
    changes: number | bigint
    lastInsertRowid: number | bigint
  }

  export class StatementSync {
    all(...params: SQLInputValue[]): Record<string, SQLOutputValue>[]
    get(...params: SQLInputValue[]): Record<string, SQLOutputValue> | undefined
    run(...params: SQLInputValue[]): StatementResultingChanges
    iterate(...params: SQLInputValue[]): IterableIterator<Record<string, SQLOutputValue>>
  }

  export interface DatabaseSyncOptions {
    open?: boolean
    readOnly?: boolean
    enableForeignKeyConstraints?: boolean
    enableDoubleQuotedStringLiterals?: boolean
    allowExtension?: boolean
    timeout?: number
  }

  export class DatabaseSync {
    constructor(location: string, options?: DatabaseSyncOptions)
    close(): void
    exec(sql: string): void
    open(): void
    prepare(sql: string): StatementSync
    readonly isOpen: boolean
    readonly isTransaction: boolean
  }
}
