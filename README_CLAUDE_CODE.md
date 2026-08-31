# DriveVoice — reprise dans Claude Code

Ce dossier contient le code source exporté du projet `drivevoice-commandes`.

## Prérequis

- Node.js 22.13 ou supérieur
- npm

## Installation

```bash
npm install
npm run dev
```

## Vérification avant déploiement

```bash
npm run build
npm run lint
```

## Fonctionnalités déjà présentes

- Interface de commande vocale DriveVoice
- Catalogue restaurant avec catégories et sous-catégories
- Composition et ingrédients réservés aux burgers
- Configuration avancée des menus : taille, plat, accompagnement, boisson et sauces
- Compositions supplémentaires pour les menus enfants : dessert et jouet
- Sélection des produits de la carte dans les étapes du menu
- Back-office des catalogues maîtres Burger King, Quick et KFC
- Gestion simulée des versions et des restaurants rattachés

## À savoir

- La configuration `.openai/hosting.json` est conservée uniquement comme trace du projet Sites existant. Elle peut être retirée si le projet est déployé ailleurs.
- Aucun dossier `node_modules`, résultat de compilation ou fichier d'environnement secret n'est inclus.
- Les données du back-office sont encore simulées dans le front-end. La prochaine phase prévue est la connexion à Supabase et la mise en place du SaaS multi-tenant.

