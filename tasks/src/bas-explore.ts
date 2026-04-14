import { connectBrowser } from "@web-auto/core";
import * as fs from "fs";

const BASE = "https://bas.batunionen.se";

const PAGES = [
  // Medlemmar
  { menu: "Medlemmar", name: "Medlem sök", path: "/MemberSearch/MemberSearch" },
  { menu: "Medlemmar", name: "Medlemsgrupper", path: "/Section/SectionSearch" },
  { menu: "Medlemmar", name: "Båtgrupper", path: "/SectionBoat/SectionBoat" },
  { menu: "Medlemmar", name: "Uppdatering medlemsuppgifter", path: "/MemberUpdateRequest/MemberUpdateRequest" },
  // Rapporter
  { menu: "Rapporter", name: "BAS rapport", path: "/CustomReport/CustomReport" },
  { menu: "Rapporter", name: "Negativa avier för migrering", path: "/CustomReport/NegativeInvoiceMigration" },
  { menu: "Rapporter", name: "Inaktiva personer (raderas)", path: "/MemberOther/MemberOther" },
  // Kommunikation
  { menu: "Kommunikation", name: "Nytt meddelande", path: "/Mail/Mail" },
  { menu: "Kommunikation", name: "Utkast", path: "/Mail/DraftMail" },
  { menu: "Kommunikation", name: "Skickat", path: "/Mail/SentMail" },
  { menu: "Kommunikation", name: "Distributionscentralen", path: "/Distribution/DistributionSearch" },
  { menu: "Kommunikation", name: "Saldo sms", path: "/Common/SmsBalance" },
  // Ekonomi
  { menu: "Ekonomi", name: "Avgifter", path: "/Fee/FeeSearch" },
  { menu: "Ekonomi", name: "Avisering", path: "/ChargeInfo/ChargeInfoSearch" },
  { menu: "Ekonomi", name: "Reskontra/Fordringar", path: "/Ledger/Ledger" },
  { menu: "Ekonomi", name: "Reskontra/Depositioner", path: "/MemberBalance/GetDepositList" },
  { menu: "Ekonomi", name: "Bokföringsunderlag", path: "/StaticReport/BookKeepingOrderReport" },
  { menu: "Ekonomi", name: "Avvikelser/Skulder", path: "/MemberBalance/GetBalanceTransactionList" },
  { menu: "Ekonomi", name: "E-fakturaanmälan Omatchade", path: "/Billecta/GetUnknownEInvoiceRegistration" },
  { menu: "Ekonomi", name: "E-fakturaanmälan Matchade", path: "/Billecta/GetUnknownProcessedEInvoiceRegistration" },
  { menu: "Ekonomi", name: "Avgiftsgrupp", path: "/FeeType/FeeType" },
  { menu: "Ekonomi", name: "OCR inläsning", path: "/PaymentProcessing/PaymentProcessing" },
  // Platshantering
  { menu: "Platshantering", name: "Platser", path: "/BasK/Storage/StorageSearch" },
  { menu: "Platshantering", name: "Områden", path: "/Area/AreaSearch" },
  { menu: "Platshantering", name: "Formel för prisintervaller", path: "/PriceByRangeFormula/PriceByRangeFormula" },
  // Kö
  { menu: "Kö", name: "Köanmälningar", path: "/WaitingListMemberSearch/WaitingListMemberSearch" },
  { menu: "Kö", name: "Administrera köer", path: "/WaitingListAdmin/WaitingListSearch" },
  // Filer
  { menu: "Filer", name: "Filer", path: "/FileManagement/FileManagement" },
  { menu: "Filer", name: "Dokumentmallar", path: "/FileManagement/DocumentTemplate" },
  // Schema
  { menu: "Schema", name: "Aktiva scheman", path: "/WatchmanListBooking/WatchmanListBooking" },
  { menu: "Schema", name: "Administrera", path: "/WatchmanListAdmin/WatchmanListAdminSearch" },
  // Inställningar
  { menu: "Inställningar", name: "Kontoplan", path: "/AccountingCode/AccountingCode" },
  { menu: "Inställningar", name: "Behörighet", path: "/UserPermission/UserPermission" },
  { menu: "Inställningar", name: "Extrafält klubbunika", path: "/Property/PropertySearch" },
  { menu: "Inställningar", name: "Referensdata", path: "/BoatRefData/BoatRefData" },
  { menu: "Inställningar", name: "Kommunikation", path: "/EmailSettings/EmailSettings" },
  { menu: "Inställningar", name: "Ekonomi", path: "/ChargeInfoSetting/ChargeInfoSetting" },
  { menu: "Inställningar", name: "Transaktionslogg", path: "/SystemSetting/TransactionLogs" },
  { menu: "Inställningar", name: "Inställningar medlemsuppdateringar", path: "/MemberEditField/MemberEditField" },
  // Utlåning
  { menu: "Utlåning", name: "Utlåning", path: "/Lending/LendingSearch" },
  { menu: "Utlåning", name: "Typer av utlåningsbara artiklar", path: "/Lending/LendingArticle" },
  // Klubb
  { menu: "Klubb", name: "Klubbkort", path: "/BoatClub/BoatClub" },
  { menu: "Klubb", name: "Årsrapport", path: "/ClubStatistic/ClubStatistics" },
  { menu: "Klubb", name: "Funktioner", path: "/Function/ClubFunctionsSearch" },
  { menu: "Klubb", name: "Uppdatera båtar via lista", path: "/BatchEdit/BatchEdit" },
  { menu: "Klubb", name: "Import", path: "/Import/Import" },
  { menu: "Klubb", name: "Inloggningskonton", path: "/BoatClub/MembersCreateAccounts" },
  { menu: "Klubb", name: "Behörighet", path: "/BoatClub/UserRights" },
  // Hjälp
  { menu: "Hjälp", name: "Wiki Bas manual", path: "/Wiki/Help" },
  { menu: "Hjälp", name: "Support", path: "/Support/SupportSearch" },
];

async function main() {
  const { activePage } = await connectBrowser();
  const page = await activePage();

  const dir = "D:/web-auto/.screenshots/bas-explore";
  fs.mkdirSync(dir, { recursive: true });

  for (let i = 0; i < PAGES.length; i++) {
    const p = PAGES[i];
    const slug = `${String(i + 1).padStart(2, "0")}-${p.name.replace(/[^a-zA-ZåäöÅÄÖ0-9]/g, "_")}`;
    const url = `${BASE}${p.path}`;

    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
      await page.screenshot({ path: `${dir}/${slug}.png`, fullPage: false });
      console.log(`[${i + 1}/${PAGES.length}] ${p.menu} > ${p.name} — OK`);
    } catch (err) {
      console.log(`[${i + 1}/${PAGES.length}] ${p.menu} > ${p.name} — FAILED: ${err}`);
    }
  }

  console.log("Done.");
}

main();
