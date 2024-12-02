import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';
import { TngDatabaseModule } from '@app/common/database-tng/tng-database.module';
import { CacheModule } from '../cache/cache.module';
import { HttpClientService } from './http-client.service';
import { HttpConfigModule } from '@app/common/http-config/http-config.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DeliveryEntity } from '@app/common/database-tng/entities';

@Module({
  imports: [
    TngDatabaseModule,
    HttpModule,
    HttpConfigModule,
    CacheModule,
    TypeOrmModule.forFeature([
      DeliveryEntity,
    ]),
  ],
  controllers: [DeliveryController],
  providers: [DeliveryService, HttpClientService],
})
export class TngModule { }
