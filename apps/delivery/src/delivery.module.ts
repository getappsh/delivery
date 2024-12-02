import { Module } from '@nestjs/common';
import { CtsModule } from './cts/cts.module';
import { TngModule } from './tng/tng.module';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from '@app/common/logger/logger.module';
import { ApmModule } from '@app/common/apm/apm.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({httpCls: false, jsonLogger: process.env.LOGGER_FORMAT === 'JSON', name: "Delivery"}),
    ApmModule,
    CtsModule
    // process.env.TARGET === "CTS" ? CtsModule : TngModule
  ]
  // imports: [process.env.TARGET === "CTS" ? CtsModule : TngModule]
})
export class DeliveryModule { }
