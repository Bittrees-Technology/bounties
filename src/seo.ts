import type { PublicWalletProfile } from "./persistence/supabase";
import type { MarketplaceOrder } from "./types";

export const SITE_URL = "https://bounties.bittrees.org";
export const SOCIAL_IMAGE_URL = `${SITE_URL}/social-preview-v2.png`;

export type SeoPage = "home" | "marketplace" | "create" | "profile" | "moderator";

export type PageSeo = {
  title: string;
  description: string;
  canonical: string;
  robots: string;
  imageAlt: string;
  schema: Record<string, unknown>;
};

type SeoContext = {
  page: SeoPage;
  bounty?: MarketplaceOrder | null;
  profileAddress?: string | null;
  profile?: PublicWalletProfile | null;
};

const defaultRobots = "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1";
const defaultImageAlt = "Bounties — fund work, deliver results, and use inspectable ERC20 escrow";

function normalizedText(value: string | null | undefined, fallback: string, maximum = 158): string {
  const normalized = value?.replace(/\s+/g, " ").trim() || fallback;
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}

function pageSchema(type: "WebPage" | "CollectionPage" | "ProfilePage", url: string, name: string, description: string, mainEntity?: Record<string, unknown>): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": type,
    "@id": `${url}#webpage`,
    url,
    name,
    description,
    isPartOf: { "@id": `${SITE_URL}/#website` },
    primaryImageOfPage: {
      "@type": "ImageObject",
      url: SOCIAL_IMAGE_URL,
      width: 1200,
      height: 630
    },
    ...(mainEntity ? { mainEntity } : {}),
    inLanguage: "en"
  };
}

export function resolvePageSeo({ page, bounty, profileAddress, profile }: SeoContext): PageSeo {
  if (page === "marketplace" && bounty) {
    const canonical = `${SITE_URL}/bounties/${bounty.id}`;
    const title = normalizedText(`${bounty.title} | Bounties`, "Bounty details | Bounties", 62);
    const description = normalizedText(
      `${bounty.project} Budget: ${bounty.budgetDisplay ?? bounty.budget} ${bounty.tokenRecord?.symbol || "ERC20"}. Review the scope, milestones, deadline, and payment record.`,
      "Review this token-funded bounty's scope, milestones, deadline, and ERC20 payment record."
    );
    return {
      title,
      description,
      canonical,
      robots: defaultRobots,
      imageAlt: `${normalizedText(bounty.title, "Bounty details", 90)} — Bounties`,
      schema: pageSchema("WebPage", canonical, title, description, {
        "@type": "Service",
        name: bounty.title,
        description: normalizedText(bounty.project, bounty.title, 500),
        serviceType: bounty.scope,
        category: bounty.category,
        url: canonical
      })
    };
  }

  if (page === "marketplace") {
    const canonical = `${SITE_URL}/marketplace`;
    const title = "Browse Token-Funded Bounties | Bounties";
    const description = "Browse scoped work with visible budgets, milestones, deadlines, token contracts, applications, and inspectable ERC20 escrow records.";
    return {
      title,
      description,
      canonical,
      robots: defaultRobots,
      imageAlt: defaultImageAlt,
      schema: pageSchema("CollectionPage", canonical, title, description, { "@type": "ItemList", name: "Token-funded bounties" })
    };
  }

  if (page === "create") {
    const canonical = `${SITE_URL}/create`;
    const title = "Create a Token-Funded Bounty | Bounties";
    const description = "Publish a bounty with a clear scope, budget, acceptance criteria, milestone schedule, deadline, and inspectable ERC20 payment terms.";
    return {
      title,
      description,
      canonical,
      robots: defaultRobots,
      imageAlt: defaultImageAlt,
      schema: pageSchema("WebPage", canonical, title, description)
    };
  }

  if (page === "profile" && profileAddress) {
    const canonical = `${SITE_URL}/profiles/${profileAddress}`;
    const identity = profile?.display_name?.trim() || profile?.ens_name?.trim() || `${profileAddress.slice(0, 6)}…${profileAddress.slice(-4)}`;
    const title = normalizedText(`${identity} — Work Profile | Bounties`, "Public work profile | Bounties", 62);
    const description = normalizedText(
      profile?.profile_bio,
      `View ${identity}'s public Bounties profile, role-specific reputation, completed work, specialties, and marketplace activity.`
    );
    return {
      title,
      description,
      canonical,
      robots: profile?.profile_moderation_status === "hidden" ? "noindex, nofollow" : defaultRobots,
      imageAlt: `${identity} — public work profile on Bounties`,
      schema: pageSchema("ProfilePage", canonical, title, description, {
        "@type": "Person",
        name: identity,
        identifier: profileAddress,
        url: canonical
      })
    };
  }

  if (page === "profile") {
    const canonical = `${SITE_URL}/profiles`;
    const title = "Discover Web3 Work Profiles | Bounties";
    const description = "Find public wallet profiles by work type and specialty, then review role-specific reputation and completed bounty activity.";
    return {
      title,
      description,
      canonical,
      robots: defaultRobots,
      imageAlt: defaultImageAlt,
      schema: pageSchema("CollectionPage", canonical, title, description, { "@type": "ItemList", name: "Bounties work profiles" })
    };
  }

  if (page === "moderator") {
    const canonical = `${SITE_URL}/moderator`;
    const title = "Moderator workspace | Bounties";
    const description = "Authorized Bounties moderation workspace.";
    return {
      title,
      description,
      canonical,
      robots: "noindex, nofollow, noarchive",
      imageAlt: defaultImageAlt,
      schema: pageSchema("WebPage", canonical, title, description)
    };
  }

  const canonical = `${SITE_URL}/`;
  const title = "Bounties | Token-Funded Work with ERC20 Escrow";
  const description = "Create and complete token-funded bounties with clear scopes, milestone payments, proposals, delivery evidence, wallet profiles, and ERC20 escrow.";
  return {
    title,
    description,
    canonical,
    robots: defaultRobots,
    imageAlt: defaultImageAlt,
    schema: pageSchema("WebPage", canonical, title, description)
  };
}

function setMeta(attribute: "name" | "property", key: string, content: string) {
  let meta = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute(attribute, key);
    document.head.append(meta);
  }
  meta.content = content;
}

function setCanonical(href: string) {
  let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement("link");
    canonical.rel = "canonical";
    document.head.append(canonical);
  }
  canonical.href = href;
}

export function applyPageSeo(context: SeoContext): PageSeo {
  const seo = resolvePageSeo(context);
  document.title = seo.title;
  setCanonical(seo.canonical);
  setMeta("name", "description", seo.description);
  setMeta("name", "robots", seo.robots);
  setMeta("property", "og:type", "website");
  setMeta("property", "og:title", seo.title);
  setMeta("property", "og:description", seo.description);
  setMeta("property", "og:url", seo.canonical);
  setMeta("property", "og:image", SOCIAL_IMAGE_URL);
  setMeta("property", "og:image:secure_url", SOCIAL_IMAGE_URL);
  setMeta("property", "og:image:type", "image/png");
  setMeta("property", "og:image:width", "1200");
  setMeta("property", "og:image:height", "630");
  setMeta("property", "og:image:alt", seo.imageAlt);
  setMeta("name", "twitter:card", "summary_large_image");
  setMeta("name", "twitter:title", seo.title);
  setMeta("name", "twitter:description", seo.description);
  setMeta("name", "twitter:image", SOCIAL_IMAGE_URL);
  setMeta("name", "twitter:image:alt", seo.imageAlt);

  let routeSchema = document.head.querySelector<HTMLScriptElement>("#bounties-route-schema");
  if (!routeSchema) {
    routeSchema = document.createElement("script");
    routeSchema.id = "bounties-route-schema";
    routeSchema.type = "application/ld+json";
    document.head.append(routeSchema);
  }
  routeSchema.textContent = JSON.stringify(seo.schema);
  return seo;
}
