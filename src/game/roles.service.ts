import { Room } from '../types/room.types';

export const ROLES = {
  mafia: { roleName: 'mafia', team: 'mafia' },
  detective: { roleName: 'detective', team: 'town' },
  doctor: { roleName: 'doctor', team: 'town' },
  citizen: { roleName: 'citizen', team: 'town' },
} as const;

export class RolesService {
  assign(room: Room) {
    if ([...room.players.values()].some(p => p.role)) return;

    const players = [...room.players.values()].sort(() => Math.random() - 0.5);
    players.forEach(p => (p.alive = true));

    const mafiaCount = Math.max(1, Math.floor(players.length / 4));
    let i = 0;

    for (; i < mafiaCount; i++) players[i].role = ROLES.mafia;
    if (players.length >= 4) players[i++].role = ROLES.detective;
    if (players.length >= 5) players[i++].role = ROLES.doctor;
    for (; i < players.length; i++) players[i].role = ROLES.citizen;
  }
}
