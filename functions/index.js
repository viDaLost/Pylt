import { initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { logger } from "firebase-functions";
import { onSchedule } from "firebase-functions/v2/scheduler";

initializeApp();

const ONE_HOUR_MS = 60 * 60 * 1000;
const TWELVE_HOURS_MS = 12 * ONE_HOUR_MS;

export const cleanupRooms = onSchedule(
  {
    schedule: "every 5 minutes",
    region: "europe-west1",
    timeZone: "Europe/Moscow",
    memory: "256MiB",
    timeoutSeconds: 120,
    maxInstances: 1
  },
  async () => {
    const database = getDatabase();
    const roomsRef = database.ref("rooms");
    const snapshot = await roomsRef.get();

    if (!snapshot.exists()) {
      logger.info("Room cleanup: no rooms found");
      return;
    }

    const now = Date.now();
    const updates = {};
    let deletedByAge = 0;
    let deletedAsEmpty = 0;
    let markedEmpty = 0;
    let clearedEmptyMarker = 0;

    for (const [roomId, room] of Object.entries(snapshot.val() || {})) {
      const meta = room?.meta || {};
      const participants = Object.values(room?.participants || {});
      const createdAt = Number(meta.createdAt || 0);
      const emptySince = Number(meta.emptySince || 0);
      const anyoneOnline = participants.some((participant) => participant?.online === true);

      if (!createdAt || now - createdAt >= TWELVE_HOURS_MS) {
        updates[roomId] = null;
        deletedByAge += 1;
        continue;
      }

      if (anyoneOnline) {
        if (emptySince) {
          updates[`${roomId}/meta/emptySince`] = null;
          clearedEmptyMarker += 1;
        }
        continue;
      }

      if (!emptySince) {
        updates[`${roomId}/meta/emptySince`] = now;
        markedEmpty += 1;
        continue;
      }

      if (now - emptySince >= ONE_HOUR_MS) {
        updates[roomId] = null;
        deletedAsEmpty += 1;
      }
    }

    if (Object.keys(updates).length > 0) {
      await roomsRef.update(updates);
    }

    logger.info("Room cleanup finished", {
      deletedByAge,
      deletedAsEmpty,
      markedEmpty,
      clearedEmptyMarker,
      changedPaths: Object.keys(updates).length
    });
  }
);
