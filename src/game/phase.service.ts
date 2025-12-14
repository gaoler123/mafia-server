// src/mafia/game/phase.service.ts
import { Room } from '../types/room.types';

export type PhaseResult =
  | { type: 'none' }
  | { type: 'start_voting' }
  | { type: 'resolve_day' }
  | { type: 'end_game'; winner: 'mafia' | 'town' };

  export class PhaseService {
    startPhase(
      room: Room,
      phase: 'night' | 'day',
      checkWin: () => 'mafia' | 'town' | null,
      onResolveDay: () => void,
      onStateChange: () => void,
    ) {
      if (room.timer) clearTimeout(room.timer);
      if (room.dayStageTimer) clearTimeout(room.dayStageTimer);
  
      room.timer = undefined;
      room.dayStageTimer = undefined;
  
      room.phase = phase;
      onStateChange();
  
      if (phase === 'day') {
        room.dayStage = 'discussion';
        room.votes = undefined;
        onStateChange();
  
        room.dayStageTimer = setTimeout(() => {
          if (room.phase !== 'day') return;
  
          room.dayStage = 'voting';
          room.votes = new Map();
          onStateChange();
        }, 30_000);
      } else {
        room.dayStage = undefined;
        room.votes = undefined;
        onStateChange();
      }
  
      room.timer = setTimeout(() => {
        if (phase === 'day') {
          onResolveDay();
          onStateChange();
        }
  
        const winner = checkWin();
        if (winner) {
          room.phase = 'ended';
          room.winner = winner;
          onStateChange();
          return;
        }
  
        const nextPhase = phase === 'night' ? 'day' : 'night';
        this.startPhase(room, nextPhase, checkWin, onResolveDay, onStateChange);
      }, phase === 'night' ? 3_000 : 6_000);
    }
  
    end(room: Room, winner: 'mafia' | 'town') {
      if (room.timer) clearTimeout(room.timer);
      if (room.dayStageTimer) clearTimeout(room.dayStageTimer);
  
      room.timer = undefined;
      room.dayStageTimer = undefined;
  
      room.phase = 'ended';
      room.winner = winner;
  
      room.players.forEach(p => (p.role = undefined));
    }
  }
  
