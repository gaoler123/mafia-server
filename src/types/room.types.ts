import { Player } from "./player.types";

export type Room = {
    id: string;
    players: Map<string, Player>;
    hostSocketId: string;
    phase: 'lobby' | 'night' | 'day' | 'ended';
    dayStage?: 'discussion' | 'voting';
    timer?: NodeJS.Timeout;
    dayStageTimer?: NodeJS.Timeout;
    winner?: 'mafia' | 'town';
    votes?: Map<string, string>;
  };