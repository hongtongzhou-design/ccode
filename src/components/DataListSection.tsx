import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Table } from "lucide-react";
import ResourceListSection from "./ResourceListSection";
import { absoluteResourcePath } from "./ArtifactChecklist";
import { pathKey } from "../path-utils";
import { IS_WINDOWS } from "../hotkeys";
import {
  isDataFile,
  isProjectNotesPath,
  partitionResources,
} from "../project-status";
import type { OfficeDocDto, ProjectResourceDto } from "../types";

export default function DataListSection({
  projectPath,
  registered,
  onAskAi,
}: {
  projectPath: string;
  registered: ProjectResourceDto[];
  onAskAi?: (
    r: ProjectResourceDto,
    e?: { metaKey: boolean; ctrlKey: boolean },
  ) => void;
}) {
  const [found, setFound] = useState<OfficeDocDto[]>([]);

  useEffect(() => {
    let cancelled = false;
    invoke<OfficeDocDto[]>("list_office_docs", { root: projectPath })
      .then((docs) => {
        if (!cancelled) setFound(docs);
      })
      .catch(() => {
        if (!cancelled) setFound([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  const resources = useMemo(() => {
    const fromToml = partitionResources(registered).data;
    const seen = new Set(
      fromToml.map((r) =>
        pathKey(absoluteResourcePath(projectPath, r.path), IS_WINDOWS),
      ),
    );
    const extra: ProjectResourceDto[] = [];
    for (const d of found) {
      if (!isDataFile(d.path) || isProjectNotesPath(d.rel)) continue;
      const key = pathKey(d.path, IS_WINDOWS);
      if (seen.has(key)) continue;
      seen.add(key);
      extra.push({
        name: d.name,
        path: d.rel,
        type: "dataset",
        readonly: false,
        note: "",
      });
    }
    return [...fromToml, ...extra];
  }, [registered, found, projectPath]);

  return (
    <ResourceListSection
      projectPath={projectPath}
      resources={resources}
      title="数据"
      emptyLabel="数据 · 还没有表格或文本"
      icon={Table}
      collapsible
      defaultOpen
      stripPrefix="data"
      onAskAi={onAskAi}
    />
  );
}
