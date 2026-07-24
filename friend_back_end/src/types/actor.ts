export type ActorLevel = "L1" | "L2" | "L3" | "L4";

export type RequestActor = {
  actorId: string;
  level: ActorLevel;
};
