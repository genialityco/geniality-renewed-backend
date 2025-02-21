import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: true,
  });

  const port = process.env.PORT || 3000;
  await app.listen(port, () =>
    console.log(`Servidor corriendo en el puerto ${port}`),
  );
}
bootstrap();
