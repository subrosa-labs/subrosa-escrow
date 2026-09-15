import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="card space-y-3">
      <h1 className="text-lg font-medium text-ash-100">Nothing here</h1>
      <p className="text-sm text-ash-300">
        That page does not exist. If you were looking for an auction, the address may be wrong — or
        the auction id may be from a different deployment of this contract.
      </p>
      <Link href="/auctions" className="btn-secondary inline-flex no-underline">
        Back to auctions
      </Link>
    </div>
  );
}
