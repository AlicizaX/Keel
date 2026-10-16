import { io, Socket } from 'socket.io-client';

export const socket: Socket = io({ path: '/ws', transports: ['websocket', 'polling'] });
