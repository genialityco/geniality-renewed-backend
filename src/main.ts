import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
// import { SessionTokenGuard } from './auth/session-token.guard';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: [
      process.env.FRONTEND_ORIGIN || '', // ej: https://tu-sitio.netlify.app
      'http://localhost:5173',
      'https://dev-gencampus.netlify.app',
    ],
    credentials: true,
  });

  // app.useGlobalGuards(app.get(SessionTokenGuard));

  const port = process.env.PORT || 3000;
  await app.listen(port, () =>
    console.log(`Servidor corriendo en el puerto ${port}`),
  );
}
bootstrap();
