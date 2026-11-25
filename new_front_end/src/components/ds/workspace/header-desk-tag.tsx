"use client";

/**
 * The desk tag in a booking's head (2026-11-25): greyed beside the name, "BOLD/MOA". A press opens a
 * small box to change it or take it off, at any step. With no tag, a quiet "＋ Tag" stays out of the
 * way until the desk wants one.
 */
import { useState } from "react";
import { Button } from "@/design-system";
import { DeskTagInput, tidyDeskTag, useInquiryDeskTag } from "@/components/ds/desk-tag";
import { DsDialog } from "@/components/ds/steps/kit";
import type { EntryDetail } from "@/types/api";

export function HeaderDeskTag({ entry }: { entry: EntryDetail }) {
  const saved = entry.inquiry?.deskTag ?? null;
  const tag = useInquiryDeskTag(entry.inquiry?.id, saved, entry.id);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  if (!entry.inquiry?.id) return null;
  const changed = !!tidyDeskTag(draft) && tidyDeskTag(draft) !== (saved ?? "");
  const openBox = () => {
    setDraft(saved ?? "");
    setOpen(true);
  };
  return (
    <>
      {saved ? (
        <button type="button" className="desk-tag" onClick={openBox} title="The desk's own note — never on a paper or an email. Press to change it.">
          {saved}
        </button>
      ) : (
        <button type="button" className="desk-tag add" onClick={openBox} title="A short note to tell this guest apart from others of the same name">
          ＋ Tag
        </button>
      )}
      <DsDialog
        open={open}
        onClose={() => setOpen(false)}
        closeX
        width={440}
        title={saved ? "Change the tag" : "Add a tag"}
        help="A short note to tell this guest apart from others of the same name — their company, group or code. It shows greyed beside the name on the desk and in the lists, and never on a paper or in an email."
        footer={
          <>
            {saved ? (
              <Button
                kind="quiet"
                onClick={() => {
                  void tag.commit("").then(() => setOpen(false));
                }}
              >
                Take it off
              </Button>
            ) : null}
            <Button kind="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              kind="primary"
              className={changed ? "go" : undefined}
              state={tag.state === "saving" ? "working" : changed ? "default" : "inert"}
              reason={changed ? undefined : tidyDeskTag(draft) ? "Nothing has changed" : "Type the tag"}
              workingLabel="Saving…"
              onClick={() => {
                void tag.commit(draft).then(() => setOpen(false));
              }}
            >
              Save the tag
            </Button>
          </>
        }
      >
        <DeskTagInput value={draft} onChange={setDraft} autoFocus />
      </DsDialog>
    </>
  );
}
