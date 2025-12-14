import { Room } from '../types/room.types';

export class VotingService {
  vote(room: Room, voterId: string, targetId: string) {
    room.votes ??= new Map();
    room.votes.set(voterId, targetId);
  }

  resolve(room: Room): string | null {
    if (!room.votes || room.votes.size === 0) return null;

    const counts = new Map<string, number>();
    for (const id of room.votes.values()) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) return null;

    return sorted[0][0];
  }
}
