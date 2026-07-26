import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { TechTrend } from './entities/tech-trend.entity';
import { InitTechTrendSchema1785067830260 } from './migrations/1785067830260-InitTechTrendSchema';
import { AddTechTrendSearchIndexes1785074539944 } from './migrations/1785074539944-AddTechTrendSearchIndexes';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST'),
        port: configService.get<number>('DB_PORT'),
        username: configService.get<string>('DB_USERNAME'),
        password: configService.get<string>('DB_PASSWORD'),
        database: configService.get<string>('DB_DATABASE'),
        entities: [TechTrend],
        synchronize: false,
        migrationsRun: true,
        migrations: [
          InitTechTrendSchema1785067830260,
          AddTechTrendSearchIndexes1785074539944
        ],
        logging: false,
        extra: {
          options: '-c timezone=Asia/Seoul',
        },
      }),
    }),
  ],
})
export class DatabaseModule {}