import { Module } from '@nestjs/common';
import { WrapHttpService } from './wrap-http.service';
import { ConfigModule } from '@nestjs/config';
import { HttpModule } from '@nestjs/axios';

@Module({
  imports: [
    ConfigModule.forRoot({isGlobal: true}),
    HttpModule
  ],
  providers: [WrapHttpService],
  exports: [WrapHttpService]
})
export class WrapHttpModule {}
