// src/mafia/utils/id.util.ts
export function generateRoomId(): string {
    return Math.random()
      .toString(36)
      .substring(2, 6)
      .toUpperCase();
  }
  