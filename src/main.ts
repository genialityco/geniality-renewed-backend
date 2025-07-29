import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
// import { SessionTokenGuard } from './auth/session-token.guard';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: true,
  });

  // app.useGlobalGuards(app.get(SessionTokenGuard));

  const port = process.env.PORT || 3000;
  await app.listen(port, () =>
    console.log(`Servidor corriendo en el puerto ${port}`),
  );
}
bootstrap();
