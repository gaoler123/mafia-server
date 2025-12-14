import { Room } from '../types/room.types';

export class WinService {
  check(room: Room): 'mafia' | 'town' | null {
    const alive = [...room.players.values()].filter(p => p.alive);
    const mafia = alive.filter(p => p.role?.team === 'mafia').length;
    const town = alive.length - mafia;

    if (mafia === 0) return 'town';
    if (mafia >= town) return 'mafia';
    return null;
  }
}
