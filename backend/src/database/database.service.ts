import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export type DbConnection = Pool | PoolConnection;

@Injectable()
export class DatabaseService {
  constructor(@Inject('MYSQL_POOL') private readonly pool: Pool) {}

  async query<T extends RowDataPacket[] | ResultSetHeader>(
    sql: string,
    params: Record<string, unknown> = {},
    connection: DbConnection = this.pool,
  ): Promise<T> {
    const [rows] = await connection.query<T>(sql, params);
    return rows;
  }

  async transaction<T>(callback: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await callback(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
