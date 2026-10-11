import { JsonMissionStore } from "@proofkit/agent";
import type { TestMission } from "@proofkit/contracts";
import { sameProjectPath, type ProjectContext } from "@proofkit/project";
import { join } from "node:path";

/** Validate ownership for every Agent load/save, including recovery and approval. */
export class ProjectMissionStore extends JsonMissionStore {
  constructor(private readonly context: ProjectContext) {
    super(join(context.metadataDir, "missions"));
  }

  override async load(missionId: string): Promise<TestMission> {
    const mission = await super.load(missionId);
    this.assertContext(mission);
    return mission;
  }

  override async save(mission: TestMission): Promise<void> {
    this.assertContext(mission);
    await super.save(mission);
  }

  override async create(mission: TestMission): Promise<void> {
    this.assertContext(mission);
    await super.create(mission);
  }

  private assertContext(mission: TestMission): void {
    if (!sameProjectPath(mission.projectRoot, this.context.projectRoot)) throw new Error("Mission belongs to another project");
    if (mission.workspaceRoot ? !sameProjectPath(mission.workspaceRoot, this.context.workspaceRoot) : !this.context.legacy) {
      throw new Error("Mission belongs to another workspace or has no workspace binding");
    }
  }
}
