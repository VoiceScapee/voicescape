"use client";

/**
 * <PostCard> — one town-hall post: author (links to their page), body,
 * timestamp, reply button, and a TIP button that runs the standard
 * tipPage(username) flow (98% creator / 2% treasury, enforced on-chain).
 */
import { useState } from "react";
import Link from "next/link";
import TipModal from "@/components/TipModal";
import { timeAgo, type TownhallPost } from "@/lib/townhall";
import { IconTip } from "@/components/icons";
import ReputationBadge from "./Reputation";
import AgentMark from "@/components/AgentMark";
import ModHideButton from "./ModHideButton";
import ReportButton from "./ReportButton";

export default function PostCard({
  post,
  onReply,
  depth = 0,
  onHidden,
}: {
  post: TownhallPost;
  onReply?: (post: TownhallPost) => void;
  depth?: number;
  /**
   * When provided, a moderator Hide button is shown (only to authorized
   * moderators, per /api/townhall/mod-status) and this callback runs after
   * a successful hide so the parent can reload.
   */
  onHidden?: () => void;
}) {
  const [tipping, setTipping] = useState(false);

  return (
    <article className="th-post" style={depth > 0 ? { marginLeft: Math.min(depth, 3) * 14 } : undefined}>
      <div className="th-post-head">
        <Link href={`/${post.author}`} className="th-post-author">
          @{post.author}
        </Link>
        {post.authorVerified === false && (
          <span
            className="th-muted"
            title="This author wasn't verified through the Voicescape API — the name may not belong to the wallet that posted it"
          >
            {" "}⚠ unverified
          </span>
        )}
        <ReputationBadge username={post.author} compact />
        <AgentMark username={post.author} />
        <span className="th-post-ts" title={new Date(post.ts).toLocaleString()}>
          {timeAgo(post.ts)}
        </span>
        {(post as { pending?: boolean }).pending && (
          <span className="th-muted" title="Sent to Hedera — waiting for network confirmation">
            {" "}◌ confirming…
          </span>
        )}
        {(post as { unconfirmed?: boolean }).unconfirmed && (
          <span className="th-muted" title="Not confirmed on-chain yet — the message may still arrive">
            {" "}⚠ not yet confirmed — it usually arrives in a few seconds
          </span>
        )}
      </div>
      <p className="th-post-body">{post.body}</p>
      <div className="th-post-actions">
        {onReply && (
          <button type="button" className="th-action" onClick={() => onReply(post)}>
            Reply
          </button>
        )}
        <button type="button" className="th-action is-tip" onClick={() => setTipping(true)}>
          <IconTip size={14} /> Tip
        </button>
        {onHidden && <ModHideButton post={post} onHidden={onHidden} />}
        <ReportButton targetKind="post" targetSeq={post.seq} />
      </div>
      {tipping && <TipModal author={post.author} onClose={() => setTipping(false)} />}
    </article>
  );
}
