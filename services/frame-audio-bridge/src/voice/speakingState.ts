export interface SpeakingStateEntry {
  discordUserId: string;
  speaking: boolean;
  changedAt: number;
}

export class SpeakingStateTracker {
  private readonly statesByUserId = new Map<string, SpeakingStateEntry>();

  public set(discordUserId: string, speaking: boolean, now = Date.now()): SpeakingStateEntry {
    const entry: SpeakingStateEntry = {
      discordUserId,
      speaking,
      changedAt: now,
    };

    this.statesByUserId.set(discordUserId, entry);
    return entry;
  }

  public list(): SpeakingStateEntry[] {
    return [...this.statesByUserId.values()].map((entry) => ({ ...entry }));
  }

  public clear(): void {
    this.statesByUserId.clear();
  }
}
