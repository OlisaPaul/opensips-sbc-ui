import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPool } from 'mysql2/promise';
import { DatabaseService } from './database.service';

@Global()
@Module({
  providers: [
    {
      provide: 'MYSQL_POOL',
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        createPool({
          host: config.get<string>('DB_HOST'),
          port: config.get<number>('DB_PORT') ?? 3306,
          user: config.get<string>('DB_USER'),
          password: config.get<string>('DB_PASSWORD'),
          database: config.get<string>('DB_NAME'),
          waitForConnections: true,
          connectionLimit: 10,
          namedPlaceholders: true,
        }),
    },
    DatabaseService,
  ],
  exports: [DatabaseService],
})
export class DatabaseModule {}
