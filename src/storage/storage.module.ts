import { Module, Global } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { StorageService } from './storage.service.js'

@Global()
@Module({
  imports: [ConfigModule],
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
