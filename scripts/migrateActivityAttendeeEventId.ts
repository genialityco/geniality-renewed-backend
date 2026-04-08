import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';

dotenv.config();

// Definir las conexiones necesarias
async function migrateActivityAttendeeEventId() {
  try {
    // Conectar a MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost/geniality');
    console.log('✅ Conectado a MongoDB');

    const db = mongoose.connection;

    // Obtener referencias a las colecciones
    const activityAttendees = db.collection('activityattendees');
    const activities = db.collection('activities');

    // 1. Encontrar todos los activityAttendee sin event_id
    const missingEventId = await activityAttendees
      .find({ event_id: { $exists: false } })
      .toArray();

    console.log(`🔍 Encontrados ${missingEventId.length} registros sin event_id`);

    if (missingEventId.length === 0) {
      console.log('✅ No hay registros para migrar');
      await mongoose.disconnect();
      return;
    }

    let updated = 0;
    let failed = 0;

    // 2. Para cada activityAttendee sin event_id, obtener el event_id de su activity
    for (const attendee of missingEventId) {
      try {
        // Buscar la activity
        const activity = await activities.findOne({
          _id: attendee.activity_id,
        });

        if (!activity || !activity.event_id) {
          console.log(`⚠️ Activity no encontrada o sin event_id: ${attendee.activity_id}`);
          failed++;
          continue;
        }

        // Actualizar el activityAttendee con event_id
        const result = await activityAttendees.updateOne(
          { _id: attendee._id },
          {
            $set: {
              event_id: activity.event_id,
            },
          },
        );

        if (result.modifiedCount === 1) {
          updated++;
          console.log(`✅ Actualizado: ${attendee._id}`);
        }
      } catch (error) {
        console.error(`❌ Error actualizando ${attendee._id}:`, error);
        failed++;
      }
    }

    console.log(`\n📊 Resultados:`);
    console.log(`   ✅ Actualizados: ${updated}`);
    console.log(`   ❌ Fallidos: ${failed}`);
    console.log(`   📈 Total procesados: ${updated + failed}`);

    // 3. Verificación final
    const stillMissing = await activityAttendees
      .find({ event_id: { $exists: false } })
      .toArray();

    console.log(`\n🔍 Registros sin event_id después de migración: ${stillMissing.length}`);

    // 4. Mostrar algunos ejemplos de registros actualizados
    const examples = await activityAttendees
      .find({ event_id: { $exists: true } })
      .limit(3)
      .toArray();

    console.log(`\n📋 Ejemplos de registros actualizados:`);
    examples.forEach((ex, i) => {
      console.log(`   ${i + 1}. ActivityAttendee ${ex._id.toString().slice(0, 8)}... → event_id: ${ex.event_id.toString().slice(0, 8)}...`);
    });

    await mongoose.disconnect();
    console.log('\n✅ Migración completada');
  } catch (error) {
    console.error('❌ Error durante la migración:', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

migrateActivityAttendeeEventId();
