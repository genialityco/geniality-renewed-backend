import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
// import { SessionTokenGuard } from './auth/session-token.guard';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: true,
    credentials: true,
  });

  // Validación global de DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // app.useGlobalGuards(app.get(SessionTokenGuard));

  const port = process.env.PORT || 3000;
  await app.listen(port, () =>
    console.log(`Servidor corriendo en el puerto ${port}`),
  );
}
bootstrap();
