"use client";

import Navbar from "@/components/Navbar";
import { WalletConnect } from "@/components/WalletConnect";
import { FollowingDigest } from "@/components/FollowingDigest";

export default function FollowingPage() {
  return (
    <>
      <Navbar right={<WalletConnect />} />
      <main>
        <FollowingDigest />
      </main>
    </>
  );
}
