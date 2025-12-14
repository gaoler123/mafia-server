import { Module } from '@nestjs/common';
import { AppService } from './app.service';
import { LobbyGateway } from './lobby/lobby.gateway';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
    }),
  ],
  providers: [AppService, LobbyGateway],
})
export class AppModule {}