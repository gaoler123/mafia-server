import { Role } from "./role.types";

export type Player = {
    socketId: string;
    username: string;
    role?: Role;
    alive: boolean;
  };